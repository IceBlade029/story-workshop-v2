/**
 * detail-tools.ts — 正文生成工具（§6.5、§6.6、§8.2）。
 *
 * detail_fill 白名单只有三个工具：read_visible_view（chat 共用，
 * §8.2）、read_format_template、write_output——物理上拿不到细纲、
 * 设定、材料（知识边界由白名单保证）。
 *
 * P1 修复（执行器层强制）：runDetailFill / runRevise 经 resourceScope
 * 注入 allowedSceneId / allowedFormat，本模块所有工具执行时严格比对
 * 模型传入值——越界读取（其他场景的可见视图、其他格式模板、其他场景
 * 输出）一律拒绝，知识边界不再只是提示词。
 */
import type { ToolContext, ToolSpec } from '../tool-types';
import { OutputRepository } from '../../storage/output-repository';
import { VisibleViewRepository } from '../../storage/visible-view-repository';
import { FormatTemplateRepository } from '../templates';
import { withProjectWriteLock } from '../../write-lock';
import { ok, fail, viewEvidence } from './tool-utils';
import { sha256 } from '../../storage/hash';

/** 模型自定义 id 的安全字符集（与仓库层 assertSafeId 一致；P0 修复）。 */
const SAFE_ID_PATTERN = '^[A-Za-z0-9_-]{1,80}$';
const SAFE_FORMAT_PATTERN = '^[a-z0-9-]{1,32}$';

/** 资源能力越界拒绝（allowedSceneId / allowedFormat 生效时）。 */
function assertSceneInScope(ctx: ToolContext, sceneId: string): { ok: boolean; error?: ReturnType<typeof fail> } {
  if (ctx.allowedSceneId !== undefined && sceneId !== ctx.allowedSceneId) {
    return { ok: false, error: fail('SCENE_OUT_OF_SCOPE', `场景 ${sceneId} 不在本次任务范围内（仅允许 ${ctx.allowedSceneId}）。`) };
  }
  return { ok: true };
}

function assertFormatInScope(ctx: ToolContext, format: string): { ok: boolean; error?: ReturnType<typeof fail> } {
  if (ctx.allowedFormat !== undefined && format !== ctx.allowedFormat) {
    return { ok: false, error: fail('FORMAT_OUT_OF_SCOPE', `格式 ${format} 不在本次任务范围内（仅允许 ${ctx.allowedFormat}）。`) };
  }
  return { ok: true };
}

export function makeDetailTools(projectDir: () => string, templates?: FormatTemplateRepository): ToolSpec[] {
  const outputs = () => new OutputRepository(projectDir());
  const views = () => new VisibleViewRepository(projectDir());
  const templateRepo = templates ?? new FormatTemplateRepository();

  return [
    {
      name: 'read_visible_view',
      description: '读取场景的可见视图（存在则返回内容与状态；不存在返回 exists=false）。正文生成的唯一内容来源。',
      inputSchema: {
        type: 'object',
        properties: {
          sceneId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '场景节点 id' },
        },
        required: ['sceneId'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx, args: { sceneId: string }) {
        const scope = assertSceneInScope(ctx, args.sceneId);
        if (!scope.ok) return scope.error!;
        const view = views().read(args.sceneId);
        if (!view) return ok({ exists: false, sceneId: args.sceneId });
        return ok(
          {
            exists: true,
            sceneId: view.sceneId,
            content: view.content,
            sourceHash: view.sourceHash,
            userEdited: view.userEdited,
            needsRegeneration: view.needsRegeneration,
            generatedAt: view.generatedAt,
          },
          [viewEvidence(args.sceneId, sha256(view.content))],
        );
      },
    },

    {
      name: 'read_format_template',
      description: '读取格式模板（格式指南文本）。可用格式：novel（小说）、script（剧本）。',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', pattern: SAFE_FORMAT_PATTERN, description: '格式名：novel | script' },
        },
        required: ['format'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx, args: { format: string }) {
        const scope = assertFormatInScope(ctx, args.format);
        if (!scope.ok) return scope.error!;
        const content = templateRepo.read(args.format);
        if (content === null) {
          return fail('FORMAT_NOT_FOUND', `未知格式: ${args.format}（可用: ${templateRepo.listFormats().join(', ')}）`);
        }
        return ok({ format: args.format, content });
      },
    },

    {
      name: 'read_output',
      description: '读取该场景当前输出的正文全文（就地改写/审阅用；正文生成器的产出落盘在 outputs/）。',
      inputSchema: {
        type: 'object',
        properties: {
          sceneId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '场景节点 id' },
          format: { type: 'string', pattern: SAFE_FORMAT_PATTERN, description: '格式名：novel | script' },
        },
        required: ['sceneId', 'format'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx, args: { sceneId: string; format: string }) {
        const sceneScope = assertSceneInScope(ctx, args.sceneId);
        if (!sceneScope.ok) return sceneScope.error!;
        const formatScope = assertFormatInScope(ctx, args.format);
        if (!formatScope.ok) return formatScope.error!;
        if (!outputs().exists(args.sceneId, args.format)) {
          return fail('OUTPUT_NOT_FOUND', `该场景还没有 ${args.format} 格式的正文（先生成正文）`);
        }
        const content = outputs().read(args.sceneId, args.format);
        return ok({ sceneId: args.sceneId, format: args.format, content }, []);
      },
    },

    {
      name: 'write_output',
      description: '把生成的正文落盘为 outputs/<sceneId>.<format>.md。',
      inputSchema: {
        type: 'object',
        properties: {
          sceneId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '场景节点 id' },
          format: { type: 'string', pattern: SAFE_FORMAT_PATTERN, description: '格式名：novel | script' },
          content: { type: 'string', description: '正文全文' },
        },
        required: ['sceneId', 'format', 'content'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { sceneId: string; format: string; content: string }) {
        const sceneScope = assertSceneInScope(ctx, args.sceneId);
        if (!sceneScope.ok) return sceneScope.error!;
        const formatScope = assertFormatInScope(ctx, args.format);
        if (!formatScope.ok) return formatScope.error!;
        if (templateRepo.read(args.format) === null) {
          return fail('FORMAT_NOT_FOUND', `未知格式: ${args.format}（可用: ${templateRepo.listFormats().join(', ')}）`);
        }
        return withProjectWriteLock(projectDir(), () => {
          // 记录生成时所依据的可见视图 hash（§3.5 输出失效检测的依据）
          const view = views().read(args.sceneId);
          const viewHash = view ? sha256(view.content) : '';
          outputs().write(args.sceneId, args.format, args.content, viewHash);
          return ok(
            { sceneId: args.sceneId, format: args.format, path: `${args.sceneId}.${args.format}.md` },
            [viewEvidence(args.sceneId, sha256(args.content))],
          );
        });
      },
    },
  ];
}

/**
 * detail-tools.ts — 正文生成工具（§6.5、§6.6、§8.2）。
 *
 * detail_fill 白名单只有三个工具：read_visible_view（chat 共用，
 * §8.2）、read_format_template、write_output——物理上拿不到细纲、
 * 设定、材料（知识边界由白名单保证）。
 */
import type { ToolContext, ToolSpec } from '../tool-types';
import { OutputRepository } from '../../storage/output-repository';
import { VisibleViewRepository } from '../../storage/visible-view-repository';
import { FormatTemplateRepository } from '../templates';
import { withProjectWriteLock } from '../../write-lock';
import { ok, fail, viewEvidence } from './tool-utils';
import { sha256 } from '../../storage/hash';

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
          sceneId: { type: 'string', description: '场景节点 id' },
        },
        required: ['sceneId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { sceneId: string }) {
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
          format: { type: 'string', description: '格式名：novel | script' },
        },
        required: ['format'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { format: string }) {
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
          sceneId: { type: 'string', description: '场景节点 id' },
          format: { type: 'string', description: '格式名：novel | script' },
        },
        required: ['sceneId', 'format'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { sceneId: string; format: string }) {
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
          sceneId: { type: 'string', description: '场景节点 id' },
          format: { type: 'string', description: '格式名：novel | script' },
          content: { type: 'string', description: '正文全文' },
        },
        required: ['sceneId', 'format', 'content'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx: ToolContext, args: { sceneId: string; format: string; content: string }) {
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

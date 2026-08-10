/**
 * write-tools.ts — organize 任务的写入工具（§8.2）。
 *
 * 写入全落草稿/设定；每个写工具在写锁标记内做同步原子写，
 * 并通过 ctx.recordChange 记录变更项（变更摘要用）。
 */
import type { ToolContext, ToolSpec } from '../tool-types';
import { OutlineRepository, OVERVIEW_ROOT_ID } from '../../storage/outline-repository';
import { AssetRepository } from '../../storage/asset-repository';
import { TrashRepository } from '../../storage/trash-repository';
import { sha256 } from '../../storage/hash';
import { assertSafeId } from '../../storage/path-safety';
import { withProjectWriteLock } from '../../write-lock';
import { ok, fail } from './tool-utils';
import { generateId } from '../../storage/id';
import type { ChangeItem, NodeType } from '../../../shared/types';

/** 模型自定义 id 的安全字符集（与仓库层 assertSafeId 一致；P0 修复）。 */
const SAFE_ID_PATTERN = '^[A-Za-z0-9_-]{1,80}$';

export function makeWriteTools(projectDir: () => string): ToolSpec[] {
  const outline = () => new OutlineRepository(projectDir());
  const assets = () => new AssetRepository(projectDir());

  return [
    {
      name: 'create_node',
      description: '在大纲树中创建节点（草稿态）。parentId 缺省为根（总纲）。新节点自动带「AI 新增」标记，等待作者审阅。',
      inputSchema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: '父节点 id（缺省 = 总纲根）' },
          type: { type: 'string', enum: ['volume', 'chapter', 'scene'], description: '节点类型' },
          title: { type: 'string', description: '节点标题' },
          nodeId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '自定义节点 id（可选；缺省自动生成）' },
          hidden: { type: 'boolean', description: '自动插入的隐藏中间层级' },
        },
        required: ['type', 'title'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { parentId?: string; type: NodeType; title: string; nodeId?: string; hidden?: boolean }) {
        return withProjectWriteLock(projectDir(), () => {
          const repo = outline();
          const parentId = args.parentId ?? OVERVIEW_ROOT_ID;
          if (ctx.allowedOrganizeNodeIds && (!ctx.allowOrganizeCreate || (parentId !== OVERVIEW_ROOT_ID && !ctx.allowedOrganizeNodeIds.has(parentId)))) {
            return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', `返修不允许在目标范围外创建节点（parentId=${parentId}）`);
          }
          const id = args.nodeId ?? generateId('n');
          if (args.nodeId !== undefined) {
            // P0 修复：模型自定义 id 必须通过安全校验（防目录穿越），
            // 校验先于任何写入——坏 id 不能进入大纲树。
            try {
              assertSafeId(args.nodeId, 'node');
            } catch {
              return fail('INVALID_NODE_ID', `节点 id 非法（仅允许字母/数字/下划线/连字符，最多 80 位）: ${args.nodeId}`);
            }
          }
          if (repo.findNode(id)) return fail('NODE_ID_CONFLICT', `节点 id 已存在: ${id}`);
          const node = {
            id,
            type: args.type,
            title: args.title,
            children: [],
            ...(args.hidden ? { hidden: true } : {}),
            aiCreated: true,
          };
          repo.createNode(parentId, node);
          ctx.allowedOrganizeNodeIds?.add(id);
          ctx.recordChange({
            action: 'node_created',
            nodeId: id,
            parentId,
            title: args.title,
          });
          return ok({ id, type: node.type, title: node.title, aiCreated: true });
        });
      },
    },

    {
      name: 'rename_node',
      description: '重命名大纲树节点。',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '节点 id' },
          title: { type: 'string', description: '新标题' },
        },
        required: ['nodeId', 'title'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { nodeId: string; title: string }) {
        return withProjectWriteLock(projectDir(), () => {
          const repo = outline();
          if (ctx.allowedOrganizeNodeIds && !ctx.allowedOrganizeNodeIds.has(args.nodeId)) {
            return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', `返修不允许重命名未选节点: ${args.nodeId}`);
          }
          const node = repo.findNode(args.nodeId);
          if (!node) return fail('NODE_NOT_FOUND', `节点不存在: ${args.nodeId}`);
          const from = node.title;
          repo.renameNode(args.nodeId, args.title);
          ctx.recordChange({ action: 'node_renamed', nodeId: args.nodeId, from, to: args.title });
          return ok({ nodeId: args.nodeId, from, to: args.title });
        });
      },
    },

    {
      name: 'delete_node',
      description: '从大纲树删除节点（含整棵子树）。内容移入项目回收站（§9.4），可恢复。',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '节点 id' },
        },
        required: ['nodeId'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { nodeId: string }) {
        return withProjectWriteLock(projectDir(), () => {
          const repo = outline();
          if (ctx.allowedOrganizeNodeIds && !ctx.allowedOrganizeNodeIds.has(args.nodeId)) {
            return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', `返修不允许删除未选节点: ${args.nodeId}`);
          }
          if (!repo.findNode(args.nodeId)) return fail('NODE_NOT_FOUND', `节点不存在: ${args.nodeId}`);
          new TrashRepository(projectDir(), repo).moveToTrash(args.nodeId);
          ctx.recordChange({ action: 'node_deleted', nodeId: args.nodeId });
          return ok({ nodeId: args.nodeId });
        });
      },
    },

    {
      name: 'write_draft',
      description: '写入节点草稿内容（覆盖已有草稿）。写入全落草稿，正式版不受影响。',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '节点 id' },
          content: { type: 'string', description: '草稿 markdown 内容' },
        },
        required: ['nodeId', 'content'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { nodeId: string; content: string }) {
        return withProjectWriteLock(projectDir(), () => {
          const repo = outline();
          if (ctx.allowedOrganizeNodeIds && !ctx.allowedOrganizeNodeIds.has(args.nodeId)) {
            return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', `返修不允许写入未选节点: ${args.nodeId}`);
          }
          if (!repo.findNode(args.nodeId)) return fail('NODE_NOT_FOUND', `节点不存在: ${args.nodeId}`);
          const before = repo.hasDraft(args.nodeId) ? sha256(repo.readDraft(args.nodeId)) : undefined;
          repo.writeDraft(args.nodeId, args.content);
          const after = sha256(args.content);
          ctx.recordChange({ action: 'draft_updated', nodeId: args.nodeId, beforeHash: before, afterHash: after });
          return ok({ nodeId: args.nodeId, draftHash: after });
        });
      },
    },

    {
      name: 'write_asset',
      description: '写入设定：不带 assetId = 创建新设定；带 assetId = 更新已有设定。type 是自由字符串（character|worldbuilding|timeline|location|prop|foreshadow|misc 或自定义）。',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', pattern: SAFE_ID_PATTERN, description: '设定 id（更新时必填；缺省 = 新建）' },
          type: { type: 'string', description: '设定类型（新建必填）' },
          title: { type: 'string', description: '标题（新建必填）' },
          content: { type: 'string', description: 'markdown 正文' },
        },
        required: ['content'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx: ToolContext, args: { assetId?: string; type?: string; title?: string; content: string }) {
        return withProjectWriteLock(projectDir(), () => {
          const repo = assets();
          if (args.assetId) {
            if (ctx.allowedOrganizeAssetIds && !ctx.allowedOrganizeAssetIds.has(args.assetId)) {
              return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', `返修不允许写入未选设定: ${args.assetId}`);
            }
            const existing = repo.readAsset(args.assetId);
            if (!existing) return fail('ASSET_NOT_FOUND', `设定不存在: ${args.assetId}`);
            const updated = repo.updateAsset(args.assetId, {
              type: args.type ?? existing.type,
              title: args.title ?? existing.title,
              content: args.content,
            })!;
            ctx.recordChange({
              action: 'asset_updated',
              assetId: updated.id,
              beforeHash: existing.hash,
              afterHash: updated.hash,
            });
            return ok({ assetId: updated.id, action: 'updated', hash: updated.hash });
          }
          if (ctx.allowedOrganizeAssetIds && !ctx.allowOrganizeCreate) {
            return fail('ORGANIZE_REVISION_OUT_OF_SCOPE', '局部返修不允许新建未选设定');
          }
          const type = args.type ?? 'misc';
          const title = args.title ?? '';
          const asset = repo.createAsset(type, title, args.content);
          ctx.allowedOrganizeAssetIds?.add(asset.id);
          ctx.recordChange({ action: 'asset_created', assetId: asset.id, type: asset.type, title: asset.title });
          return ok({ assetId: asset.id, action: 'created', type: asset.type, title: asset.title, hash: asset.hash });
        });
      },
    },
  ];
}

export type { ChangeItem };

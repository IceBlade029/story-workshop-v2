/**
 * node-tools.ts — 大纲/细纲读取工具（chat 白名单；organize 只读部分）。
 * 只读，不落盘。
 */
import type { ToolSpec } from '../tool-types';
import { OutlineRepository, OVERVIEW_ROOT_ID } from '../../storage/outline-repository';
import { sha256 } from '../../storage/hash';
import { ok, fail, nodeEvidence, matchesQuery, sliceToolContent } from './tool-utils';
import type { NodeType, OutlineNode } from '../../../shared/types';

interface FlatNode {
  id: string;
  type: NodeType;
  title: string;
  parentId: string | null;
  hidden?: boolean;
  aiCreated?: boolean;
  depth: number;
}

function flattenTree(
  node: OutlineNode,
  parentId: string | null,
  depth: number,
  out: FlatNode[],
): void {
  out.push({
    id: node.id,
    type: node.type,
    title: node.title,
    parentId,
    hidden: node.hidden,
    aiCreated: node.aiCreated,
    depth,
  });
  for (const child of node.children) {
    flattenTree(child, node.id, depth + 1, out);
  }
}

export function makeNodeReadTools(projectDir: () => string): ToolSpec[] {
  const outline = () => new OutlineRepository(projectDir());

  return [
    {
      name: 'list_nodes',
      description: '列出大纲树全部节点（id、类型、标题、父节点、AI 新增标记）。可传 type 过滤（overview|volume|chapter|scene）。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['overview', 'volume', 'chapter', 'scene'], description: '按类型过滤，可选' },
        },
      } as never,
      outputSchema: {} as never,
      async execute() {
        const tree = outline().readTree();
        if (!tree) return fail('OUTLINE_NOT_INITIALIZED', '大纲树尚未初始化');
        const flat: FlatNode[] = [];
        flattenTree(tree.root, null, 0, flat);
        return ok(
          { rootId: OVERVIEW_ROOT_ID, nodes: flat },
          [{ sourceId: 'outline', sourceType: 'node', hash: sha256(JSON.stringify(tree)) }],
        );
      },
    },

    {
      name: 'read_node',
      description: '分段读取节点正式版内容与元数据（含官方 hash、是否有草稿）。默认最多 40000 字。',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 id' },
          start: { type: 'number', description: '起始字符位置（缺省 0）' },
          maxChars: { type: 'number', description: '本段最大字符数（缺省 40000，最高 100000）' },
        },
        required: ['nodeId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { nodeId: string; start?: number; maxChars?: number }) {
        const repo = outline();
        const node = repo.findNode(args.nodeId);
        if (!node) return fail('NODE_NOT_FOUND', `节点不存在: ${args.nodeId}`);
        const content = repo.readOfficial(args.nodeId);
        const meta = repo.readMeta(args.nodeId);
        const sliced = sliceToolContent(content, args.start, args.maxChars);
        return ok(
          {
            id: node.id,
            type: node.type,
            title: node.title,
            hidden: node.hidden ?? false,
            aiCreated: node.aiCreated ?? false,
            content: sliced.content,
            range: sliced.range,
            officialHash: meta.officialHash ?? sha256(content),
            hasDraft: repo.hasDraft(node.id),
            updatedAt: meta.updatedAt,
          },
          [nodeEvidence(node.id, meta.officialHash ?? sha256(content), sliced.content.slice(0, 200))],
          sliced.range.hasMore,
        );
      },
    },

    {
      name: 'read_draft',
      description: '分段读取节点草稿内容与草稿 hash。默认最多 40000 字。',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 id' },
          start: { type: 'number', description: '起始字符位置（缺省 0）' },
          maxChars: { type: 'number', description: '本段最大字符数（缺省 40000，最高 100000）' },
        },
        required: ['nodeId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { nodeId: string; start?: number; maxChars?: number }) {
        const repo = outline();
        if (!repo.findNode(args.nodeId)) return fail('NODE_NOT_FOUND', `节点不存在: ${args.nodeId}`);
        if (!repo.hasDraft(args.nodeId)) return fail('DRAFT_NOT_FOUND', `节点没有草稿: ${args.nodeId}`);
        const content = repo.readDraft(args.nodeId);
        const sliced = sliceToolContent(content, args.start, args.maxChars);
        return ok(
          { nodeId: args.nodeId, content: sliced.content, range: sliced.range, draftHash: sha256(content) },
          [nodeEvidence(args.nodeId, sha256(content), sliced.content.slice(0, 200))],
          sliced.range.hasMore,
        );
      },
    },

    {
      name: 'search_nodes',
      description: '在节点标题、正式版与草稿内容中搜索（大小写不敏感子串匹配），返回匹配节点列表。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
          limit: { type: 'number', description: '最多返回条数（默认 10）' },
        },
        required: ['query'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { query: string; limit?: number }) {
        const repo = outline();
        const tree = repo.readTree();
        if (!tree) return fail('OUTLINE_NOT_INITIALIZED', '大纲树尚未初始化');
        const limit = args.limit ?? 10;
        const flat: FlatNode[] = [];
        flattenTree(tree.root, null, 0, flat);
        const matches: Array<FlatNode & { match: string; hash: string }> = [];
        for (const node of flat) {
          if (matches.length >= limit) break;
          const official = repo.readOfficial(node.id);
          const draft = repo.hasDraft(node.id) ? repo.readDraft(node.id) : '';
          const officialHash = repo.readMeta(node.id).officialHash ?? sha256(official);
          if (matchesQuery(node.title, args.query)) {
            matches.push({ ...node, match: `标题:${node.title}`, hash: officialHash });
          } else if (matchesQuery(official, args.query)) {
            matches.push({ ...node, match: `正式版:…${excerpt(official, args.query)}…`, hash: officialHash });
          } else if (draft && matchesQuery(draft, args.query)) {
            matches.push({ ...node, match: `草稿:…${excerpt(draft, args.query)}…`, hash: sha256(draft) });
          }
        }
        return ok(
          { query: args.query, matches },
          matches.map((m) => nodeEvidence(m.id, m.hash, m.match)),
        );
      },
    },
  ];
}

function excerpt(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, 100);
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 60);
  return content.slice(start, end);
}

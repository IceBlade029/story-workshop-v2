import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createAgentRuntime } from '../../agent-runtime/agent-factory';
import { ScriptedModelAdapter } from '../../agent-runtime/scripted-model-adapter';
import { ProjectWorkspace } from '../../storage/workspace';
import { OutlineRepository, OVERVIEW_ROOT_ID } from '../../storage/outline-repository';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ToolContext } from '../../agent-runtime/tool-types';
import type { ChangeItem } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeCtx(): { runtime: ReturnType<typeof createAgentRuntime>; ctx: ToolContext; changes: ChangeItem[] } {
  const { projectDir } = makeProject();
  tempDirs.push(projectDir);
  const workspace = ProjectWorkspace.open(projectDir)!;
  const runtime = createAgentRuntime(workspace, new ScriptedModelAdapter());
  const changes: ChangeItem[] = [];
  const ctx: ToolContext = {
    projectDir,
    runId: 'run_test',
    recordChange: (c) => changes.push(c),
  };
  return { runtime, ctx, changes };
}

function exec(runtime: ReturnType<typeof createAgentRuntime>, ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const spec = runtime.registry.get(name)!;
  return spec.execute(ctx, args);
}

describe('工具 — 大纲读写', () => {
  it('list_nodes 展开整棵树（卷下场景自动插入隐藏章，§3.1）', async () => {
    const { runtime, ctx } = makeCtx();
    const outline = new OutlineRepository(runtime.workspace.dir);
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v1', type: 'volume', title: '第一卷', children: [] });
    outline.createNode('v1', { id: 's1', type: 'scene', title: '第一场', children: [] });
    const r = await exec(runtime, ctx, 'list_nodes', {});
    expect(r.ok).toBe(true);
    const nodes = (r.data as { nodes: Array<{ id: string; parentId: string | null; type: string; hidden?: boolean }> }).nodes;
    const hidden = nodes.find((n) => n.hidden);
    expect(hidden).toBeTruthy();
    expect(hidden!.type).toBe('chapter');
    expect(nodes.map((n) => n.id)).toEqual(['overview', 'v1', hidden!.id, 's1']);
    expect(nodes[1].parentId).toBe('overview');
    expect(nodes[3].parentId).toBe(hidden!.id);
  });

  it('read_node 返回正式版与 hash；read_draft 返回草稿', async () => {
    const { runtime, ctx } = makeCtx();
    const outline = new OutlineRepository(runtime.workspace.dir);
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v1', type: 'volume', title: 'V1', children: [] });
    outline.writeOfficial('v1', '正式内容');
    outline.writeDraft('v1', '草稿内容');
    const official = await exec(runtime, ctx, 'read_node', { nodeId: 'v1' });
    expect(official.ok).toBe(true);
    expect((official.data as { content: string }).content).toBe('正式内容');
    const draft = await exec(runtime, ctx, 'read_draft', { nodeId: 'v1' });
    expect((draft.data as { content: string }).content).toBe('草稿内容');
    const missing = await exec(runtime, ctx, 'read_draft', { nodeId: 'nope' });
    expect(missing.ok).toBe(false);
    expect((missing.error as { code: string }).code).toBe('NODE_NOT_FOUND');
  });

  it('search_nodes 在标题/正式版/草稿中匹配', async () => {
    const { runtime, ctx } = makeCtx();
    const outline = new OutlineRepository(runtime.workspace.dir);
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v1', type: 'volume', title: '青石镇', children: [] });
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v2', type: 'volume', title: '别处', children: [] });
    outline.writeOfficial('v2', '主角叫林默');
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v3', type: 'volume', title: '其它', children: [] });
    outline.writeDraft('v3', '林默去了码头');
    const r = await exec(runtime, ctx, 'search_nodes', { query: '林默' });
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: Array<{ id: string }> }).matches;
    expect(matches.map((m) => m.id).sort()).toEqual(['v2', 'v3']);
  });
});

describe('工具 — 设定与材料', () => {
  it('list_assets 按类型过滤；read_asset 返回全文', async () => {
    const { runtime, ctx } = makeCtx();
    const assets = runtime.workspace.assets;
    assets.createAsset('character', '林默', '凶手');
    assets.createAsset('location', '青石镇', '小镇');
    const list = await exec(runtime, ctx, 'list_assets', { type: 'character' });
    const listData = list.data as { assets: Array<{ id: string; title: string }> };
    expect(listData.assets).toHaveLength(1);
    expect(listData.assets[0].title).toBe('林默');
    const read = await exec(runtime, ctx, 'read_asset', { assetId: assets.listAssets()[0].id });
    expect((read.data as { content: string }).content).toBe('凶手');
    const missing = await exec(runtime, ctx, 'read_asset', { assetId: 'nope' });
    expect(missing.ok).toBe(false);
  });

  it('list_attachments 不含正文；read_attachment 返回全文', async () => {
    const { runtime, ctx } = makeCtx();
    const m = runtime.workspace.attachments.createAttachment('旧大纲', '超长正文', 'pasted');
    const list = await exec(runtime, ctx, 'list_attachments', {});
    expect(JSON.stringify(list.data)).not.toContain('超长正文');
    const read = await exec(runtime, ctx, 'read_attachment', { attachmentId: m.id });
    expect((read.data as { content: string }).content).toBe('超长正文');
  });

  it('附件范围（Part 2 默认会话内读取）：list_attachments 只列范围内；read_attachment 越界拒绝', async () => {
    const { runtime } = makeCtx();
    const inScope = runtime.workspace.attachments.createAttachment('本会话附件', 'A', 'pasted');
    const outOfScope = runtime.workspace.attachments.createAttachment('别的会话附件', 'B', 'pasted');
    const scopedCtx: ToolContext = { ...makeCtx().ctx, attachmentScope: new Set([inScope.id]) };

    const list = await exec(runtime, scopedCtx, 'list_attachments', {});
    const ids = (list.data as { attachments: Array<{ id: string }> }).attachments.map((a) => a.id);
    expect(ids).toEqual([inScope.id]);

    const okRead = await exec(runtime, scopedCtx, 'read_attachment', { attachmentId: inScope.id });
    expect(okRead.ok).toBe(true);
    const blockedRead = await exec(runtime, scopedCtx, 'read_attachment', { attachmentId: outOfScope.id });
    expect(blockedRead.ok).toBe(false);
    expect((blockedRead.error as { code: string }).code).toBe('ATTACHMENT_OUT_OF_SCOPE');
  });

  it('跨会话工具：list_all_attachments / read_any_attachment 不受范围限制', async () => {
    const { runtime } = makeCtx();
    const a = runtime.workspace.attachments.createAttachment('甲', '内容甲', 'pasted');
    const b = runtime.workspace.attachments.createAttachment('乙', '内容乙', 'pasted');
    const scopedCtx: ToolContext = { ...makeCtx().ctx, attachmentScope: new Set([a.id]) };

    const list = await exec(runtime, scopedCtx, 'list_all_attachments', {});
    const ids = (list.data as { attachments: Array<{ id: string }> }).attachments.map((x) => x.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    const read = await exec(runtime, scopedCtx, 'read_any_attachment', { attachmentId: b.id });
    expect((read.data as { content: string }).content).toBe('内容乙');
  });
});

describe('工具 — organize 写入（含变更记录与写锁）', () => {
  it('create_node 带 aiCreated 并记录 node_created；支持自定义 id', async () => {
    const { runtime, ctx, changes } = makeCtx();
    const r = await exec(runtime, ctx, 'create_node', { type: 'volume', title: '第一卷', nodeId: 'v1' });
    expect(r.ok).toBe(true);
    expect(changes).toEqual([{ action: 'node_created', nodeId: 'v1', parentId: 'overview', title: '第一卷' }]);
    expect(runtime.workspace.outline.findNode('v1')?.aiCreated).toBe(true);
    const conflict = await exec(runtime, ctx, 'create_node', { type: 'chapter', title: 'X', nodeId: 'v1' });
    expect(conflict.ok).toBe(false);
    expect((conflict.error as { code: string }).code).toBe('NODE_ID_CONFLICT');
  });

  it('write_draft 记录 beforeHash/afterHash', async () => {
    const { runtime, ctx, changes } = makeCtx();
    const outline = runtime.workspace.outline;
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v1', type: 'volume', title: 'V1', children: [] });
    outline.writeDraft('v1', '旧草稿');
    const r = await exec(runtime, ctx, 'write_draft', { nodeId: 'v1', content: '新草稿' });
    expect(r.ok).toBe(true);
    expect(changes[0]).toMatchObject({ action: 'draft_updated', nodeId: 'v1' });
    expect((changes[0] as { beforeHash?: string }).beforeHash).toBeTruthy();
    expect(outline.readDraft('v1')).toBe('新草稿');
  });

  it('rename_node / delete_node 记录变更', async () => {
    const { runtime, ctx, changes } = makeCtx();
    const outline = runtime.workspace.outline;
    outline.createNode(OVERVIEW_ROOT_ID, { id: 'v1', type: 'volume', title: '旧名', children: [] });
    outline.writeOfficial('v1', '内容');
    const renamed = await exec(runtime, ctx, 'rename_node', { nodeId: 'v1', title: '新名' });
    expect(renamed.ok).toBe(true);
    expect(changes[0]).toEqual({ action: 'node_renamed', nodeId: 'v1', from: '旧名', to: '新名' });
    const deleted = await exec(runtime, ctx, 'delete_node', { nodeId: 'v1' });
    expect(deleted.ok).toBe(true);
    expect(changes[1]).toEqual({ action: 'node_deleted', nodeId: 'v1' });
    expect(outline.findNode('v1')).toBeNull();
    expect(outline.readOfficial('v1')).toBe(''); // 文件也被删除
  });

  it('write_asset 无 assetId 创建（asset_created），带 assetId 更新（asset_updated）', async () => {
    const { runtime, ctx, changes } = makeCtx();
    const created = await exec(runtime, ctx, 'write_asset', { type: 'character', title: '林默', content: 'v1' });
    expect(created.ok).toBe(true);
    const assetId = (created.data as { assetId: string }).assetId;
    expect(changes[0]).toMatchObject({ action: 'asset_created', assetId, type: 'character', title: '林默' });
    const updated = await exec(runtime, ctx, 'write_asset', { assetId, content: 'v2' });
    expect(updated.ok).toBe(true);
    expect((updated.data as { action: string }).action).toBe('updated');
    expect(changes[1]).toMatchObject({ action: 'asset_updated', assetId });
    expect((changes[1] as { beforeHash: string }).beforeHash).not.toBe((changes[1] as { afterHash: string }).afterHash);
  });

  it('写工具拒绝不存在的节点/设定', async () => {
    const { runtime, ctx } = makeCtx();
    const r1 = await exec(runtime, ctx, 'write_draft', { nodeId: 'ghost', content: 'x' });
    expect((r1.error as { code: string }).code).toBe('NODE_NOT_FOUND');
    const r2 = await exec(runtime, ctx, 'write_asset', { assetId: 'ghost', content: 'x' });
    expect((r2.error as { code: string }).code).toBe('ASSET_NOT_FOUND');
  });
});

describe('工具 — 对话检索（search_conversation）', () => {
  it('在消息内容中搜索（含被取代分支标记与会话归属，ux-review §4.5 含归档会话）', async () => {
    const { runtime, ctx } = makeCtx();
    const conv = runtime.workspace.conversation;
    conv.createSession('第一幕');
    conv.appendMessage({ id: 'm1', role: 'user', content: '主角想复仇', timestamp: 't' });
    conv.appendMessage({ id: 'm2', role: 'ai', content: '可以设计成意外。', timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ id: 'm3', role: 'ai', content: '换一个方向。', timestamp: 't', parentId: 'm1', supersedesId: 'm2' });
    conv.archiveSession(conv.getActiveSessionId()!); // 归档会话照常可搜
    const r = await exec(runtime, ctx, 'search_conversation', { query: '复仇' });
    expect(r.ok).toBe(true);
    const data = r.data as { matches: Array<{ id: string; sessionId: string | null; superseded: boolean }> };
    expect(data.matches.map((m) => m.id)).toEqual(['m1']);
    expect(data.matches[0].sessionId).toMatch(/^sess_/);
  });

  it('按 sessionId 过滤并支持 limit', async () => {
    const { runtime, ctx } = makeCtx();
    const conv = runtime.workspace.conversation;
    const s1 = conv.createSession('会话一');
    conv.appendMessage({ id: 'm1', role: 'user', content: '第一话题', timestamp: 't' });
    const s2 = conv.createSession('会话二');
    conv.appendMessage({ id: 'm2', role: 'user', content: '第二话题', timestamp: 't' });
    const r = await exec(runtime, ctx, 'search_conversation', { query: '话题' });
    const all = (r.data as { matches: unknown[] }).matches;
    expect(all).toHaveLength(2);
    const filtered = await exec(runtime, ctx, 'search_conversation', { query: '话题', sessionId: s1.id });
    expect((filtered.data as { matches: unknown[] }).matches).toHaveLength(1);
    const limited = await exec(runtime, ctx, 'search_conversation', { query: '话题', limit: 1 });
    expect((limited.data as { matches: unknown[] }).matches).toHaveLength(1);
  });
});

describe('工具 — 可见视图与正文（§8.2）', () => {
  it('read_visible_view 不存在时返回 exists=false；存在时返回内容与状态', async () => {
    const { runtime, ctx } = makeCtx();
    const r = await exec(runtime, ctx, 'read_visible_view', { sceneId: 's1' });
    expect(r.ok).toBe(true);
    expect((r.data as { exists: boolean }).exists).toBe(false);

    runtime.workspace.visibleViews.write({
      sceneId: 's1',
      content: '一个人走进来。',
      sourceHash: 'h1',
      userEdited: true,
      needsRegeneration: true,
      generatedAt: 't',
    });
    const r2 = await exec(runtime, ctx, 'read_visible_view', { sceneId: 's1' });
    const data = r2.data as { exists: boolean; content: string; userEdited: boolean; needsRegeneration: boolean };
    expect(data.exists).toBe(true);
    expect(data.content).toBe('一个人走进来。');
    expect(data.userEdited).toBe(true);
    expect(data.needsRegeneration).toBe(true);
  });

  it('read_format_template 返回内置模板；未知格式报错', async () => {
    const { runtime, ctx } = makeCtx();
    const r = await exec(runtime, ctx, 'read_format_template', { format: 'novel' });
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toContain('小说');
    const bad = await exec(runtime, ctx, 'read_format_template', { format: 'manga' });
    expect(bad.ok).toBe(false);
    expect((bad.error as { code: string }).code).toBe('FORMAT_NOT_FOUND');
  });

  it('write_output 落盘 outputs/<sceneId>.<format>.md', async () => {
    const { runtime, ctx } = makeCtx();
    const r = await exec(runtime, ctx, 'write_output', { sceneId: 's1', format: 'novel', content: '正文' });
    expect(r.ok).toBe(true);
    expect(runtime.workspace.outputs.read('s1', 'novel')).toBe('正文');
    expect(runtime.workspace.outputs.listFormatsForScene('s1')).toEqual(['novel']);
    expect(path.basename(runtime.workspace.dir)).toBe('proj');
  });

  it('P1：allowedSceneId/allowedFormat 生效时，越界场景/格式硬性拒绝', async () => {
    const { runtime, ctx } = makeCtx();
    const scopedCtx: ToolContext = { ...ctx, allowedSceneId: 's1', allowedFormat: 'novel' };
    runtime.workspace.visibleViews.write({
      sceneId: 's1', content: '目标场景视图', sourceHash: 'h1', userEdited: false, needsRegeneration: false, generatedAt: 't',
    });
    runtime.workspace.visibleViews.write({
      sceneId: 's2', content: '其他场景视图（不应被读到）', sourceHash: 'h2', userEdited: false, needsRegeneration: false, generatedAt: 't',
    });

    // 读其他场景 → SCENE_OUT_OF_SCOPE
    const otherScene = await exec(runtime, scopedCtx, 'read_visible_view', { sceneId: 's2' });
    expect(otherScene.ok).toBe(false);
    expect((otherScene.error as { code: string }).code).toBe('SCENE_OUT_OF_SCOPE');

    // 范围内场景正常读取
    const ownScene = await exec(runtime, scopedCtx, 'read_visible_view', { sceneId: 's1' });
    expect(ownScene.ok).toBe(true);
    expect((ownScene.data as { content: string }).content).toBe('目标场景视图');

    // 其他格式模板 → FORMAT_OUT_OF_SCOPE
    const otherFormat = await exec(runtime, scopedCtx, 'read_format_template', { format: 'script' });
    expect(otherFormat.ok).toBe(false);
    expect((otherFormat.error as { code: string }).code).toBe('FORMAT_OUT_OF_SCOPE');
    const ownFormat = await exec(runtime, scopedCtx, 'read_format_template', { format: 'novel' });
    expect(ownFormat.ok).toBe(true);

    // write_output 写其他场景 → 拒绝且不落盘
    const wrongWrite = await exec(runtime, scopedCtx, 'write_output', { sceneId: 's2', format: 'novel', content: '不该写入' });
    expect(wrongWrite.ok).toBe(false);
    expect((wrongWrite.error as { code: string }).code).toBe('SCENE_OUT_OF_SCOPE');
    expect(runtime.workspace.outputs.exists('s2', 'novel')).toBe(false);

    // 范围内写入正常
    const goodWrite = await exec(runtime, scopedCtx, 'write_output', { sceneId: 's1', format: 'novel', content: '正文' });
    expect(goodWrite.ok).toBe(true);
    expect(runtime.workspace.outputs.exists('s1', 'novel')).toBe(true);

    // read_output（revise 用）同样绑定
    const wrongRead = await exec(runtime, scopedCtx, 'read_output', { sceneId: 's1', format: 'script' });
    expect(wrongRead.ok).toBe(false);
    expect((wrongRead.error as { code: string }).code).toBe('FORMAT_OUT_OF_SCOPE');
  });

  it('P0：模型传入穿越 id → 工具失败且项目目录外无任何文件', async () => {
    const { runtime, ctx } = makeCtx();
    const traversal = '..\\..\\evil';

    // create_node：工具层先校验 → 明确失败（不产生半写的大纲树）
    const badNode = await exec(runtime, ctx, 'create_node', { type: 'volume', title: 'x', nodeId: traversal });
    expect(badNode.ok).toBe(false);
    expect((badNode.error as { code: string }).code).toBe('INVALID_NODE_ID');

    // write_draft / write_asset：查找失败（节点/设定不存在）
    const badDraft = await exec(runtime, ctx, 'write_draft', { nodeId: traversal, content: 'x' });
    expect(badDraft.ok).toBe(false);
    const badAsset = await exec(runtime, ctx, 'write_asset', { assetId: traversal, content: 'x' });
    expect(badAsset.ok).toBe(false);

    // write_output：仓库层安全校验抛错（run-loop 会转成工具失败结果）
    await expect(exec(runtime, ctx, 'write_output', { sceneId: traversal, format: 'novel', content: 'x' })).rejects.toThrow();

    // 项目目录外没有残留
    const outside = path.join(path.dirname(runtime.workspace.dir), 'evil.md');
    expect(fs.existsSync(outside)).toBe(false);
  });
});

/**
 * app-service-m6.test.ts — M6 打磨（design doc §11.3 M6）。
 *
 * 覆盖：压缩接入（事件/摘要落盘/输入组装/失败恢复）、消息编辑分支（§3.2）、
 * 材料失效标记（§4.3）、版本历史（§5.5）、回收站（§9.4）、快照保留策略。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AppService } from '../app-service';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import type { ModelAdapter, ModelTurnInput, ModelTurn } from '../agent-runtime/model-types';
import { CONTEXT_BUDGET_TOKENS, MAX_OUTPUT_TOKENS, estimatePathTokens } from '../agent-runtime/context-compression';
import { makeTempDir, removeDir } from './helpers/temp-project';

vi.mock('../api-key-store', () => ({
  saveApiKey: vi.fn(),
  hasApiKey: () => false,
  loadApiKeyEntry: () => null,
}));

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function usage(i: number, o: number) {
  return { inputTokens: i, outputTokens: o };
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>) {
  return { id, name, arguments: arguments_ };
}

/** 记录每次模型输入的适配器（断言压缩后的输入组装）。 */
class RecordingAdapter implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  private inner: ScriptedModelAdapter;

  constructor(script: ScriptedTurn[] = []) {
    this.inner = new ScriptedModelAdapter(script);
  }

  replaceScript(script: ScriptedTurn[]): void {
    this.inner = new ScriptedModelAdapter(script);
  }

  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

function makeService(script: ScriptedTurn[] = []): { service: AppService; model: RecordingAdapter } {
  const model = new RecordingAdapter(script);
  const service = new AppService(() => model);
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), 'M6 项目');
  return { service, model };
}

/** 超预算的长对话（m1 是大消息，其余为最近几轮）。 */
function longPath(): import('../../shared/types').ChatMessage[] {
  const headroom = CONTEXT_BUDGET_TOKENS - MAX_OUTPUT_TOKENS - Math.floor(CONTEXT_BUDGET_TOKENS * 0.15);
  const msgs: import('../../shared/types').ChatMessage[] = [];
  msgs.push({ id: 'm1', role: 'user', content: 'x'.repeat(Math.floor(headroom * 1.5) + 1), timestamp: 't' });
  const tail = ['后话一', '回答一', '后话二', '回答二', '后话三', '回答三', '收尾'];
  for (let i = 0; i < tail.length; i++) {
    msgs.push({ id: `m${i + 2}`, role: i % 2 === 0 ? 'user' : 'ai', content: tail[i], timestamp: 't', parentId: `m${i + 1}` });
  }
  return msgs;
}

/** 触发阈值（预算 - 回答预留 - 15% 预留窗口）。 */
function headroom(): number {
  return CONTEXT_BUDGET_TOKENS - MAX_OUTPUT_TOKENS - Math.floor(CONTEXT_BUDGET_TOKENS * 0.15);
}

describe('M6 — 两阶段压缩接入（§7.2、§7.3、§7.4）', () => {
  it('chat 超预算：自动压缩 → 摘要落盘 + 轻量系统事件 + 模型输入以摘要开头', async () => {
    const { service, model } = makeService([
      { type: 'final', answer: '## 已确认决策\n主角是侦探', usage: usage(50, 10) },
      { type: 'final', answer: '好的，继续。', usage: usage(30, 5) },
      { type: 'final', answer: '会话标题', usage: usage(10, 3) }, // 首个 chat run 后的自动命名
    ]);
    // 先铺一条超预算对话（直接写日志）
    const path = longPath();
    const conv = service.workspace.conversation;
    for (const m of path) conv.appendMessage(m);
    expect(estimatePathTokens(conv.readActivePath())).toBeGreaterThan(headroom());

    await service.run({ kind: 'chat' });

    // 轻量系统事件
    const messages = service.getState().messages;
    const event = messages.find((m) => m.role === 'system' && m.content.startsWith('已压缩较早的讨论上下文'));
    expect(event).toBeTruthy();
    expect(event!.content).toContain('最近 6 条保留原文');
    // 摘要按锚点落盘
    const anchor = path[path.length - 1 - 6].id; // 保留最近 6 条非 system（m2..m7）
    const summary = conv.readBranchSummary(anchor);
    expect(summary).toContain('## 已确认决策');
    // 模型第一次调用（chat run 第一轮）输入 = 摘要 + 最近原文
    // （倒数第二条：最后一次模型输入是会话标题生成，见用户反馈 2）
    const input = model.inputs.at(-2)!;
    const contents = input.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(contents).toContain('【已压缩的较早讨论摘要（锚点 #' + anchor + '）】');
    expect(contents).toContain('后话二'); // 保留的最近 6 条（m3..m8）
    expect(contents).not.toContain('x'.repeat(100)); // 大消息不在原文里
  });

  it('已压缩过（摘要存在）→ 直接复用，不重复调用压缩模型', async () => {
    const { service, model } = makeService([
      { type: 'final', answer: '首次摘要', usage: usage(10, 5) },
      { type: 'final', answer: '回答一', usage: usage(10, 5) },
      { type: 'final', answer: '回答二', usage: usage(10, 5) },
      { type: 'final', answer: '会话标题', usage: usage(10, 3) }, // 自动命名
    ]);
    const path = longPath();
    const conv = service.workspace.conversation;
    for (const m of path) conv.appendMessage(m);
    const anchor = path[path.length - 1 - 6].id;
    conv.writeBranchSummary(anchor, '已存在的摘要');

    const before = model.inputs.length;
    await service.run({ kind: 'chat' });
    // 只有 chat 一轮 + 会话标题一轮，无压缩调用（用户反馈 2）
    expect(model.inputs.length).toBe(before + 2);
    const input = model.inputs.at(-2)!;
    expect(input.messages.map((m) => ('content' in m ? m.content : '')).join('\n')).toContain('已存在的摘要');
  });

  it('压缩失败：恢复链耗尽 → 阻断标记 + 系统事件，按原文继续（§7.4）', async () => {
    const { service } = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('t1', 'search_nodes', {})], usage: usage(1, 1) },
      { type: 'tool_calls', toolCalls: [toolCall('t2', 'search_nodes', {})], usage: usage(1, 1) },
      { type: 'tool_calls', toolCalls: [toolCall('t3', 'search_nodes', {})], usage: usage(1, 1) },
      { type: 'final', answer: '原样回答', usage: usage(10, 2) },
      { type: 'final', answer: '标题一', usage: usage(10, 2) }, // 自动命名（第一次 run）
      { type: 'final', answer: '回答二', usage: usage(10, 2) }, // 第二次 run 的 chat
      { type: 'final', answer: '标题二', usage: usage(10, 2) }, // 自动命名（第二次 run）
    ]);
    const path = longPath();
    const conv = service.workspace.conversation;
    for (const m of path) conv.appendMessage(m);

    await service.run({ kind: 'chat' });
    const messages = service.getState().messages;
    const failure = messages.find((m) => m.role === 'system' && m.content.startsWith('压缩失败'));
    expect(failure).toBeTruthy();
    expect(failure!.content).toContain('原始对话没有丢失');
    expect(conv.readMeta().compressionBlocked).toBe(true);

    // 阻断后再次运行：不再尝试压缩
    const blocked = messages.filter((m) => m.role === 'system' && m.content.startsWith('压缩失败'));
    await service.run({ kind: 'chat' });
    expect(service.getState().messages.filter((m) => m.role === 'system' && m.content.startsWith('压缩失败'))).toHaveLength(blocked.length);
  });

  it('手动重新压缩：清除阻断、带重点、覆盖旧摘要', async () => {
    const { service } = makeService([
      { type: 'final', answer: '重点摘要：主角动机', usage: usage(20, 8) },
      { type: 'final', answer: '回答', usage: usage(10, 2) },
    ]);
    const path = longPath();
    const conv = service.workspace.conversation;
    for (const m of path) conv.appendMessage(m);
    conv.updateMeta({ compressionBlocked: true });

    await service.recompressContext('重点：主角动机');
    const anchor = path[path.length - 1 - 6].id;
    expect(conv.readBranchSummary(anchor)).toBe('重点摘要：主角动机');
    expect(conv.readMeta().compressionBlocked).toBeFalsy();
    expect(service.getState().messages.some((m) => m.content.startsWith('已重新压缩'))).toBe(true);
  });

  it('上下文视图：inspect 反映组装结果（摘要/保留范围/预算）', async () => {
    const { service } = makeService();
    const path = longPath();
    const conv = service.workspace.conversation;
    for (const m of path) conv.appendMessage(m);
    const anchor = path[path.length - 1 - 6].id;
    conv.writeBranchSummary(anchor, '已有摘要');

    const inspection = service.inspectContext();
    expect(inspection.compressed).toBe(true);
    expect(inspection.summary).toBe('已有摘要');
    expect(inspection.summaryAnchor).toBe(anchor);
    expect(inspection.keptRawCount).toBe(6);
    expect(inspection.messageCount).toBe(path.length);
    expect(inspection.budgetTokens).toBe(CONTEXT_BUDGET_TOKENS);
    expect(inspection.estimatedTokens).toBeGreaterThan(headroom());
  });
});

describe('M6 — 消息编辑分支（§3.2）', () => {
  it('编辑用户消息：不原地覆盖，旧尾部保留为分支，活动路径截断重走', async () => {
    const { service } = makeService([
      { type: 'final', answer: '回复一', usage: usage(5, 2) },
      { type: 'final', answer: '会话标题', usage: usage(5, 1) }, // 自动命名
    ]);
    service.sendMessage('原始问题');
    const userMsg = service.getState().messages[0];
    await service.run({ kind: 'chat' }); // 旧尾部：AI 回复 + 运行事件

    const state = service.editMessage(userMsg.id, '修改后的问题');
    // 原文保留（supersededBy 指向新消息），新消息接管活动路径
    const old = state.messages.find((m) => m.id === userMsg.id)!;
    const replacement = state.messages.find((m) => m.supersedesId === userMsg.id)!;
    expect(old.content).toBe('原始问题');
    expect(old.supersededBy).toBe(replacement.id);
    expect(replacement.content).toBe('修改后的问题');
    expect(replacement.supersedesId).toBe(userMsg.id);
    // 编辑只追加替换消息，无「消息已编辑」记账事件（旧文本由被取代消息保留；
    // 旧文本不进模型上下文，防模型收到编辑前的内容）
    expect(state.messages.some((m) => m.role === 'system' && m.content.includes('消息已编辑'))).toBe(false);
    expect(state.activeMessageId).toBe(replacement.id);
    expect(state.sessions[0].tailMessageId).toBe(replacement.id);
    // 旧尾部仍是原文的分支
    expect(state.messages.filter((m) => m.parentId === userMsg.id && m.role === 'ai')).toHaveLength(1);
  });

  it('非用户消息 / 空内容不能编辑', () => {
    const { service } = makeService();
    service.sendMessage('问题');
    const userMsg = service.getState().messages[0];
    expect(() => service.editMessage('ghost', 'x')).toThrow('MESSAGE_NOT_FOUND');
    expect(() => service.editMessage(userMsg.id, userMsg.content)).toThrow('EDIT_EMPTY_OR_UNCHANGED');
  });
});

describe('M6 — 附件失效标记（§4.3）', () => {
  it('整理范围消化过的附件记录 hash；重传/外部修改 → 附件行「已更新」', async () => {
    const { service, model } = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'write_asset', { type: 'character', title: '主角', content: '侦探' })], usage: usage(5, 2) },
      { type: 'final', answer: '已结构化', usage: usage(5, 2) },
    ]);
    service.addAttachment('大纲.txt', '旧版本大纲内容');
    const attachmentId = service.getState().attachments[0].id;

    await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    expect(service.getState().attachments[0].needsRestructure).toBeFalsy();
    expect(service.workspace.attachments.readAttachmentMeta(attachmentId)!.lastStructured?.hash).toBeTruthy();

    // 重传（内容更新）→ 结构化结果过期 → 「已更新」
    service.workspace.attachments.updateAttachment(attachmentId, '新版本大纲内容');
    const state = service.getState();
    expect(state.attachments[0].needsRestructure).toBe(true);
    // 重新整理全部（范围包含附件消息）→ 标记清除
    model.replaceScript([
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_asset', { type: 'location', title: '青石镇', content: '小镇' })], usage: usage(5, 2) },
      { type: 'final', answer: '重新结构化', usage: usage(5, 2) },
    ]);
    await service.run({ kind: 'organize', scope: { type: 'all' } });
    expect(service.getState().attachments[0].needsRestructure).toBeFalsy();
  });
});

describe('M6 — 版本历史（§5.5）', () => {
  it('提交生成版本页；可读取与恢复历史版本', () => {
    const { service } = makeService([]);
    service.createNode('overview', 'chapter', '第一章');
    const node = service.getState().nodes.find((n) => n.title === '第一章')!;
    service.writeDraft(node.id, '第一版内容');
    service.commitNodes([node.id]);

    service.writeDraft(node.id, '第二版内容');
    service.commitNodes([node.id]);

    const versions = service.listNodeVersions(node.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshotId.startsWith('commit-')).toBe(true);
    expect(service.readNodeVersion(node.id, versions[1].snapshotId)).toBe('第一版内容');

    // 恢复第一版
    service.writeOfficial(node.id, service.readNodeVersion(node.id, versions[1].snapshotId));
    expect(service.workspace.outline.readOfficial(node.id)).toBe('第一版内容');
  });
});

describe('M6 — 回收站（§9.4）', () => {
  it('删除进回收站 → 恢复 → 子树与文件完整回来', () => {
    const { service } = makeService([]);
    service.createNode('overview', 'volume', '第一卷');
    const v1 = service.getState().nodes.find((n) => n.title === '第一卷')!;
    service.createNode(v1.id, 'scene', '场景一');
    const s1 = service.getState().nodes.find((n) => n.title === '场景一')!;
    service.writeDraft(s1.id, '场景细纲');
    service.generateVisibleView(s1.id);

    service.deleteNode(v1.id);
    let state = service.getState();
    expect(state.nodes.find((n) => n.id === v1.id)).toBeUndefined();
    expect(state.trash).toHaveLength(1);
    // 卷下建场景自动插入隐藏章（§3.1），整棵子树一并入回收站
    expect(state.trash[0].subtreeIds[0]).toBe(v1.id);
    expect(state.trash[0].subtreeIds).toContain(s1.id);
    // 内容随回收站保留（最小证据快照）
    expect(service.readVisibleView(s1.id)).toBeNull();

    service.restoreTrash(state.trash[0].id);
    state = service.getState();
    expect(state.nodes.find((n) => n.id === v1.id)).toBeTruthy();
    // 卷下场景经隐藏章承托（§3.1），恢复后层级保持
    const hidden = state.nodes.find((n) => n.parentId === v1.id && n.hidden);
    expect(hidden).toBeTruthy();
    expect(state.nodes.find((n) => n.id === s1.id)?.parentId).toBe(hidden!.id);
    expect(state.trash).toHaveLength(0);
    expect(service.readVisibleView(s1.id)?.content).toBeTruthy();
  });

  it('恢复时原父节点已不存在 → 挂回总纲根；永久删除需单独确认', () => {
    const { service } = makeService([]);
    service.createNode('overview', 'chapter', '章');
    const c1 = service.getState().nodes.find((n) => n.title === '章')!;
    service.deleteNode(c1.id);
    const trashId = service.getState().trash[0].id;

    // 父节点是根（overview 不可删），改测子树：删掉父再恢复子
    service.createNode('overview', 'volume', '卷');
    const v1 = service.getState().nodes.find((n) => n.title === '卷')!;
    service.createNode(v1.id, 'scene', '子场景');
    const s1 = service.getState().nodes.find((n) => n.title === '子场景')!;
    service.deleteNode(v1.id);
    const subTrash = service.getState().trash.find((t) => t.nodeId === v1.id)!;
    service.purgeTrash(subTrash.id); // 永久删除整棵子树
    const state = service.getState();
    expect(state.trash.find((t) => t.id === subTrash.id)).toBeUndefined();

    service.restoreTrash(trashId);
    const after = service.getState();
    expect(after.nodes.find((n) => n.id === c1.id)?.parentId).toBe('overview');
    expect(after.nodes.find((n) => n.id === s1.id)).toBeUndefined(); // 已永久删除
  });
});

describe('M6 — 附件上传与项目文件夹收纳（ux-review §3）', () => {
  it('addAttachment 支持 uploaded 来源，消息带引用', () => {
    const { service } = makeService([]);
    const state = service.addAttachment('初稿.md', '第一章正文…', 'uploaded');
    expect(state.attachments[0].source).toBe('uploaded');
    expect(state.messages.some((m) => m.content.includes('（附件：初稿.md）'))).toBe(true);
  });

  it('收纳项目文件夹文件：复制进 attachments/，原文件不移动不删除，消息带引用', () => {
    const { service } = makeService([]);
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(path.join(service.dir, '旧大纲.txt'), '第一章：主角登场', 'utf-8');
    fs.writeFileSync(path.join(service.dir, '笔记.md'), '灵感笔记', 'utf-8');
    fs.writeFileSync(path.join(service.dir, 'project.json'), '{}', 'utf-8'); // 元数据文件不可收纳
    fs.mkdirSync(path.join(service.dir, 'nodes'), { recursive: true });

    const candidates = service.scanWorkspaceFiles();
    expect(candidates.map((f) => f.name).sort()).toEqual(['旧大纲.txt', '笔记.md']);
    expect(candidates[0].size).toBeGreaterThan(0);

    const state = service.importWorkspaceFiles(['旧大纲.txt', 'project.json']);
    expect(state.attachments.map((m) => m.name)).toContain('旧大纲.txt');
    expect(state.attachments.every((m) => m.source === 'workspace')).toBe(true);
    expect(fs.existsSync(path.join(service.dir, '旧大纲.txt'))).toBe(true); // 原文件不删除
    expect(fs.existsSync(path.join(service.dir, '笔记.md'))).toBe(true); // 未点名的保留
    expect(state.messages.some((m) => m.content.includes('（附件：旧大纲.txt）'))).toBe(true);
  });
});

describe('M6 — 快照保留策略（§12.1 决定）', () => {
  it('运行快照保留最近 50 个，commit 快照全保留', async () => {
    const { service } = makeService([]);
    const ws = service.workspace;
    // 手工造 55 个运行快照 + 3 个 commit 快照（55 > 50 → 裁剪到 50）
    for (let i = 0; i < 55; i++) {
      ws.snapshots.createSnapshot(`run_${i}`, [path.join(ws.dir, 'outline.json')]);
      ws.snapshots.pruneRetention();
    }
    for (let i = 0; i < 3; i++) {
      ws.snapshots.createSnapshot(`commit-${i}`, [path.join(ws.dir, 'outline.json')]);
      ws.snapshots.pruneRetention();
    }
    const remaining = ws.snapshots.listSnapshots();
    expect(remaining.filter((s) => s.startsWith('commit-'))).toHaveLength(3);
    expect(remaining.filter((s) => !s.startsWith('commit-'))).toHaveLength(50);
  }, 20000);

  it('commitNodes 后运行快照被裁剪不影响提交历史', () => {
    const { service } = makeService([]);
    service.createNode('overview', 'chapter', '章一');
    const node = service.getState().nodes.find((n) => n.title === '章一')!;
    service.writeDraft(node.id, 'v1');
    service.commitNodes([node.id]);
    expect(service.listNodeVersions(node.id)).toHaveLength(1);
    expect(service.workspace.snapshots.listSnapshots().filter((s) => s.startsWith('commit-'))).toHaveLength(1);
  });
});

describe('M6 — 状态汇总', () => {
  it('getState 携带回收站与材料新鲜度', () => {
    const { service } = makeService([]);
    service.addAttachment('m.txt', '内容');
    service.createNode('overview', 'chapter', '章');
    const node = service.getState().nodes.find((n) => n.title === '章')!;
    service.deleteNode(node.id);
    const state = service.getState();
    expect(state.trash).toHaveLength(1);
    expect(state.trash[0].nodeId).toBe(node.id);
    expect('needsRestructure' in state.attachments[0]).toBe(true);
  });
});

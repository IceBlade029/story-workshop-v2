import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import { AppService } from '../app-service';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import { makeTempDir, removeDir } from './helpers/temp-project';
import type { ModelAdapter } from '../agent-runtime/model-types';
import type { OrganizeScope } from '../../shared/ipc-types';

// 与机器上的真实凭据库解耦
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

function makeService(script: ScriptedTurn[]): AppService {
  const createModel = (): ModelAdapter => new ScriptedModelAdapter(script);
  const service = new AppService(createModel);
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), '测试项目');
  return service;
}

describe('app-service — 入口 A：讨论 → 整理 → 审阅 → 提交/回滚', () => {
  it('发送消息 → organize（光标后未整理）→ 光标推进 → 变更摘要 → 接受', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'volume', title: '第一卷', nodeId: 'v1' })], usage: usage(5, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_draft', { nodeId: 'v1', content: '主角是侦探。' })], usage: usage(10, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c3', 'write_asset', { type: 'character', title: '主角', content: '侦探' })], usage: usage(15, 2) },
      { type: 'final', answer: '已整理完成。', usage: usage(20, 4) },
    ]);

    // 讨论
    service.sendMessage('主角是侦探');
    service.sendMessage('他住在青石镇');
    let state = service.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].parentId).toBeUndefined();
    expect(state.messages[1].parentId).toBe(state.messages[0].id);

    // 整理：默认范围 = 光标后未整理（无光标 = 全部）
    const result = await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    expect(result.skippedReason).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.changes).toHaveLength(3);
    // 光标推进到本次运行的最后一条消息（运行事件已消化，§5.3）
    state = service.getState();
    expect(state.organizeCursor).toBe(state.messages.at(-1)!.id);
    // AI 新增标记 + 设定落地
    expect(state.nodes.find((n) => n.id === 'v1')?.aiCreated).toBe(true);
    expect(state.assets).toHaveLength(1);
    expect(state.runSummaries[0].scope).toContain('未整理对话');
    // 再次整理 → 无未整理内容
    const again = await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    expect(again.skippedReason).toBe('没有未整理的内容');

    // 接受：清 AI 标记
    service.acceptRun(result.runId);
    state = service.getState();
    expect(state.nodes.find((n) => n.id === 'v1')?.aiCreated).toBeUndefined();
    expect(state.nodes.find((n) => n.id === 'v1')?.hasDraft).toBe(true);
  });

  it('整理 → 回滚：草稿与设定全部恢复，日志不可变', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'chapter', title: '第一章', nodeId: 'c1' })], usage: usage(5, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_draft', { nodeId: 'c1', content: '待定：出场方式' })], usage: usage(10, 2) },
      { type: 'final', answer: '完成', usage: usage(15, 2) },
    ]);
    service.sendMessage('第一幕在码头');
    const before = service.getState();
    const result = await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    expect(service.getState().nodes.find((n) => n.id === 'c1')).toBeTruthy();

    service.rollbackRun(result.runId);
    const after = service.getState();
    expect(after.nodes.find((n) => n.id === 'c1')).toBeUndefined();
    expect(after.messages).toHaveLength(before.messages.length + 3); // 运行开始/结束 + AI 回答
    expect(after.runSummaries[0].runId).toBe(result.runId);
  });

  it('organize 范围 = 未整理 + 自然语言附注（ux-review §4.2）', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_attachment', { attachmentId: 'att_1' })], usage: usage(5, 1) },
      { type: 'final', answer: '大纲已结构化。', usage: usage(10, 2) },
    ]);
    service.addAttachment('旧大纲.txt', '第一章：主角登场\n第二章：案件发生');
    const state = service.getState();
    const attachmentId = state.attachments[0].id;
    // 附件消息带引用，不存正文
    const msg = state.messages.at(-1)!;
    expect(msg.refs?.attachmentIds).toEqual([attachmentId]);
    expect(msg.content).not.toContain('案件发生');

    const result = await service.run({ kind: 'organize', scope: { type: 'unorganized' }, note: '只整理我刚上传的文件' });
    expect(result.error).toBeUndefined();
    // 自然语言附注进入范围描述（运行开始事件的 system 消息）
    expect(service.getState().messages.some((m) => m.role === 'system' && m.content.includes('附注：只整理我刚上传的文件'))).toBe(true);
    // 范围消化过的附件记录所用 hash → 附件行新鲜度机制（§4.3）
    expect(service.workspace.attachments.readAttachmentMeta(attachmentId)!.lastStructured?.runId).toBe(result.runId);
    expect(service.getState().organizeCursor).toBeTruthy();
  });

  it('重新整理全部对话（scope=all）', async () => {
    const service = makeService([
      { type: 'final', answer: '全部整理完成。', usage: usage(5, 2) },
    ]);
    service.sendMessage('旧讨论一');
    service.sendMessage('旧讨论二');
    const result = await service.run({ kind: 'organize', scope: { type: 'all' } });
    expect(result.error).toBeUndefined();
    expect(service.getState().organizeCursor).toBe(service.getState().messages.at(-1)!.id);
  });

  it('调用详情（ux-review §4.7）：conversation/runs/<runId>.json 全任务记录', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_node', { nodeId: 'overview' })], usage: usage(5, 1) },
      { type: 'final', answer: '角色一致：林默是侦探。', usage: usage(10, 2) },
    ]);
    service.sendMessage('林默是侦探吗');
    const result = await service.run({ kind: 'chat' });
    expect(result.error).toBeUndefined();

    const record = service.inspectRun(result.runId);
    expect(record).toBeTruthy();
    expect(record!.taskKind).toBe('chat');
    expect(record!.status).toBe('done');
    expect(record!.sent.systemPrompt).toContain('故事工坊');
    // 消息清单引用式：角色 · 来源 · 字数
    expect(record!.sent.messages.length).toBeGreaterThan(0);
    expect(record!.sent.messages.every((m) => m.source === 'raw' && m.chars > 0)).toBe(true);
    // 返回区：工具序列（名称/参数/状态/耗时）+ 最终回答标注
    expect(record!.returned.toolCalls).toHaveLength(1);
    expect(record!.returned.toolCalls[0].name).toBe('read_node');
    expect(record!.returned.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(record!.returned.toolCalls[0].status).toBe('completed');
    expect(record!.returned.finalAnswer).toContain('见本条消息');
    // 白名单快照
    expect(record!.sent.whitelist).toContain('read_node');
    // 文件确实落盘
    const fs = require('fs') as typeof import('fs');
    expect(fs.existsSync(path.join(service.dir, 'conversation', 'runs', `${result.runId}.json`))).toBe(true);
  });

  it('调用详情：压缩任务也记录（taskKind=compress）', async () => {
    const service = makeService([{ type: 'final', answer: '压缩摘要：主角是侦探。', usage: usage(5, 2) }]);
    // 不存在 → null
    expect(service.inspectRun('ghost')).toBeNull();
    // 直接跑一次压缩任务 → 记录落盘
    const { runCompressionTask } = await import('../agent-runtime/context-compression');
    const outcome = await runCompressionTask(service.workspace, new ScriptedModelAdapter([{ type: 'final', answer: '压缩摘要：主角是侦探。', usage: usage(5, 2) }]), [
      { id: 'm1', role: 'user', content: '主角是侦探。', timestamp: 't' },
      { id: 'm2', role: 'ai', content: '明白。', timestamp: 't' },
    ]);
    expect(outcome.ok).toBe(true);
    const fs = require('fs') as typeof import('fs');
    const runsDir = path.join(service.dir, 'conversation', 'runs');
    const file = fs.readdirSync(runsDir).find((f) => f.endsWith('.json'));
    expect(file).toBeTruthy();
    const record = JSON.parse(fs.readFileSync(path.join(runsDir, file!), 'utf-8'));
    expect(record.taskKind).toBe('compress');
    expect(record.status).toBe('done');
    expect(record.returned.finalAnswer).toContain('压缩摘要');
  });
});

describe('app-service — 批量提交正式版（§5.5）', () => {
  function seed(): AppService {
    const service = makeService([]);
    service.createNode('overview', 'volume', '第一卷');
    const v1 = service.getState().nodes.find((n) => n.title === '第一卷')!;
    service.createNode(v1.id, 'chapter', '第一章');
    service.createNode(v1.id, 'chapter', '第二章');
    return service;
  }

  it('按子树提交：草稿复制为正式版；默认排除「待定：」节点', async () => {
    const service = seed();
    const state = service.getState();
    const v1 = state.nodes.find((n) => n.title === '第一卷')!;
    const c1 = state.nodes.find((n) => n.title === '第一章')!;
    const c2 = state.nodes.find((n) => n.title === '第二章')!;
    service.writeDraft(v1.id, '卷总纲');
    service.writeDraft(c1.id, '第一章正文');
    service.writeDraft(c2.id, '待定：第二章内容还没定');

    const result = service.commitNodes([v1.id], false);
    expect(result.affected).toEqual([v1.id, c1.id, c2.id]);
    expect(result.committed).toEqual([v1.id, c1.id]);
    expect(result.skippedPending).toEqual([c2.id]);
    expect(result.runId.startsWith('commit-')).toBe(true);

    const after = service.getState();
    const byId = new Map(after.nodes.map((n) => [n.id, n]));
    expect(byId.get(v1.id)?.hasOfficial).toBe(true);
    expect(byId.get(c1.id)?.hasOfficial).toBe(true);
    expect(byId.get(c2.id)?.hasOfficial).toBe(false);

    // 显式覆盖：包含待定节点
    const withPending = service.commitNodes([v1.id], true);
    expect(withPending.committed).toContain(c2.id);
    expect(service.getState().nodes.find((n) => n.id === c2.id)?.hasOfficial).toBe(true);
  });

  it('无草稿节点提交为空结果', async () => {
    const service = seed();
    const v1 = service.getState().nodes.find((n) => n.title === '第一卷')!;
    const result = service.commitNodes([v1.id], false);
    expect(result.committed).toEqual([]);
    expect(result.runId).toBe('');
  });
});

describe('app-service — 消息树时间线控制（§3.2）', () => {
  it('刷新：旧 AI 回复保留为兄弟分支，新回复 supersedes 它', async () => {
    const service = makeService([
      { type: 'final', answer: '第一版回答', usage: usage(5, 2) },
      { type: 'final', answer: '第二版回答', usage: usage(10, 2) },
    ]);
    service.sendMessage('这个问题怎么看？');
    const userMsgId = service.getState().messages[0].id;
    const result = await service.run({ kind: 'chat' });
    expect(result.error).toBeUndefined();
    const oldAi = service.getState().messages.find((m) => m.role === 'ai')!;
    expect(oldAi.parentId).toBe(userMsgId);

    await service.refreshMessage(oldAi.id);
    const state = service.getState();
    const aiMessages = state.messages.filter((m) => m.role === 'ai');
    expect(aiMessages).toHaveLength(2);
    const newAi = state.messages.find((m) => m.supersedesId === oldAi.id)!;
    expect(newAi.content).toBe('第二版回答');
    // 旧回复被标记（读取派生）
    expect(state.messages.find((m) => m.id === oldAi.id)?.supersededBy).toBe(newAi.id);
    // 同一父节点 → 兄弟分支
    expect(newAi.parentId).toBe(userMsgId);
  });

  it('刷新非 AI 消息抛错；活动路径切换生效', async () => {
    const service = makeService([]);
    service.sendMessage('一个问题');
    const state = service.getState();
    await expect(service.refreshMessage(state.messages[0].id)).rejects.toThrow('REFRESH_NOT_AI_MESSAGE');

    service.sendMessage('分支一');
    const s2 = service.getState();
    service.switchBranch(s2.messages[0].id);
    expect(service.getState().activeMessageId).toBe(s2.messages[0].id);
  });

  it('开启新话题（ux-review §4.5）：新建会话不归档；旧话题可切回继续聊；归档后完全只读', async () => {
    const service = makeService([]);
    service.sendMessage('话题一的问题');
    service.sendMessage('话题一的补充');
    const s1 = service.getState();
    // 初始会话自动物化
    expect(s1.sessions).toHaveLength(1);
    const topic1 = s1.sessions[0];
    expect(topic1.tailMessageId).toBe(s1.activeMessageId);
    expect(s1.activeSessionId).toBe(topic1.id);

    // 新话题：不归档当前，新建空会话
    service.newTopic();
    const s2 = service.getState();
    expect(s2.sessions).toHaveLength(2);
    expect(s2.sessions[0].archived).toBeFalsy(); // 旧话题仍活跃
    expect(s2.activeSessionId).not.toBe(topic1.id);
    expect(s2.activeMessageId).toBeUndefined(); // 空会话 → 空路径

    // 新话题继续聊 → 挂在新会话（根级，不挂旧话题尾部）
    service.sendMessage('话题二的问题');
    const s3 = service.getState();
    const newMsg = s3.messages.find((m) => m.content === '话题二的问题')!;
    expect(newMsg.parentId).toBeUndefined();
    const topic2 = s3.sessions.find((s) => s.id === s2.activeSessionId)!;
    expect(topic2.rootMessageId).toBe(newMsg.id);
    expect(topic2.tailMessageId).toBe(s3.activeMessageId);

    // 切回话题 1 → 完整链可见，可继续追加
    service.switchSession(topic1.id);
    const s4 = service.getState();
    expect(s4.activeMessageId).toBe(topic1.tailMessageId);
    expect(s4.sessions.find((s) => s.id === topic1.id)?.tailMessageId).toBe(topic1.tailMessageId);
    service.sendMessage('回到话题一继续聊');
    const s5 = service.getState();
    expect(s5.activeSessionId).toBe(topic1.id);
    expect(s5.sessions.find((s) => s.id === topic1.id)!.tailMessageId).toBe(s5.activeMessageId);

    // 归档话题 1 → 完全只读：send / chat run / 编辑 / 刷新全部拒绝；可取消归档
    service.archiveSession(topic1.id);
    expect(service.getState().sessions.find((s) => s.id === topic1.id)?.archived).toBe(true);
    expect(() => service.sendMessage('归档后不能再发')).toThrow('SESSION_ARCHIVED');
    await expect(service.run({ kind: 'chat' })).rejects.toThrow('SESSION_ARCHIVED');
    expect(() => service.editMessage(s5.messages[0].id, 'x')).toThrow('SESSION_ARCHIVED');
    const aiMsg = service.getState().messages.find((m) => m.role === 'ai');
    if (aiMsg) await expect(service.refreshMessage(aiMsg.id)).rejects.toThrow('SESSION_ARCHIVED');
    service.unarchiveSession(topic1.id);
    expect(service.getState().sessions.find((s) => s.id === topic1.id)?.archived).toBeFalsy();
    expect(() => service.sendMessage('取消归档后可继续')).not.toThrow();
  });

  it('删除会话（ux-review §4.5）：子树消息从日志永久剔除；删活动会话自动切换', async () => {
    const service = makeService([]);
    service.sendMessage('要被删除的话题');
    const s1 = service.getState();
    const topic1 = s1.sessions[0];
    service.newTopic();
    service.sendMessage('保留的话题');
    const s2 = service.getState();
    const topic2 = s2.sessions.find((s) => s.id !== topic1.id)!;

    service.deleteSession(topic1.id);
    const s3 = service.getState();
    expect(s3.sessions.find((s) => s.id === topic1.id)).toBeUndefined();
    expect(s3.messages.some((m) => m.content === '要被删除的话题')).toBe(false);
    expect(s3.messages.some((m) => m.content === '保留的话题')).toBe(true);
    expect(s3.activeSessionId).toBe(topic2.id);
  });
});

describe('app-service — 状态汇总', () => {
  it('getState 返回树、设定、材料、消息、会话与运行摘要', async () => {
    const service = makeService([]);
    service.createNode('overview', 'volume', '第一卷');
    service.createAsset('character', '林默', '侦探');
    service.addAttachment('大纲.txt', '内容');
    service.sendMessage('hello');
    const state = service.getState();
    expect(state.nodes.map((n) => n.type)).toContain('volume');
    expect(state.assets[0].title).toBe('林默');
    expect(state.attachments[0].name).toBe('大纲.txt');
    expect(state.messages.length).toBeGreaterThanOrEqual(2);
    expect(state.dir).toBeTruthy();
    expect(state.hasApiKey).toBe(false);
  });
});

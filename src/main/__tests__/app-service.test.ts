import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppService } from '../app-service';
import { ProjectWorkspace } from '../storage/workspace';
import { configureSettingsDir, getSettings, saveSettings } from '../settings-store';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import { makeTempDir, removeDir } from './helpers/temp-project';
import type { ModelAdapter, ModelTurnInput, ModelTurn, ModelTurnOptions } from '../agent-runtime/model-types';
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

/** 记录每次模型输入的适配器（断言模型实际收到的上下文，Part 5）。 */
class InputRecordingModel implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  constructor(private readonly inner: ModelAdapter) {}
  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

function makeRecordingService(script: ScriptedTurn[]): { service: AppService; model: InputRecordingModel } {
  const model = new InputRecordingModel(new ScriptedModelAdapter(script));
  const service = new AppService(() => model);
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), '测试项目');
  return { service, model };
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

  it('整理 → 回滚：草稿与设定全部恢复，日志零新增（organize 沙箱化，Part 4）', async () => {
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
    expect(after.messages).toHaveLength(before.messages.length); // 整理不写日志：零新增（Part 4）
    expect(after.runSummaries[0].runId).toBe(result.runId);
  });

  it('organize 范围 = 未整理 + 自然语言附注（ux-review §4.2）', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_attachment', { attachmentId: 'att_1' })], usage: usage(5, 1) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_draft', { nodeId: 'overview', content: '总纲草稿' })], usage: usage(8, 2) },
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
    // 自然语言附注进入范围描述（organize 沙箱化后不在运行事件里，改存运行摘要）
    expect(service.getState().runSummaries[0].scope).toContain('附注：只整理我刚上传的文件');
    // 范围消化过的附件记录所用 hash → 附件行新鲜度机制（§4.3）
    expect(service.workspace.attachments.readAttachmentMeta(attachmentId)!.lastStructured?.runId).toBe(result.runId);
    // 光标推进到范围最后一条消息（organize 不写日志，光标不再指向运行结束事件）
    expect(service.getState().organizeCursor).toBe(service.getState().messages.at(-1)!.id);
    // 沙箱化：整理不产生任何日志行
    expect(service.getState().messages).toHaveLength(state.messages.length);
  });

  it('重新整理全部对话（scope=all）', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'write_asset', { type: 'character', title: '主角', content: '侦探' })], usage: usage(5, 2) },
      { type: 'final', answer: '全部整理完成。', usage: usage(10, 2) },
    ]);
    service.sendMessage('旧讨论一');
    service.sendMessage('旧讨论二');
    const result = await service.run({ kind: 'organize', scope: { type: 'all' } });
    expect(result.error).toBeUndefined();
    // 光标推进到全日志最后一条消息
    expect(service.getState().organizeCursor).toBe(service.getState().messages.at(-1)!.id);
    // 沙箱化：整理不写日志（消息数不变）
    expect(service.getState().messages).toHaveLength(2);
  });

  it('整理硬门禁（Part 4）：模型只输出讨论未调用写入工具 → ORGANIZE_NO_WRITE_TOOL，光标不推进', async () => {
    const service = makeService([
      { type: 'final', answer: '这些不是整理任务，而是讨论任务。请选一个方向往下钻。', usage: usage(5, 2) },
    ]);
    service.sendMessage('第一幕在码头');
    const before = service.getState();
    const result = await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    expect(result.error).toContain('ORGANIZE_NO_WRITE_TOOL');
    // 光标不推进 → 内容保持未整理
    expect(service.getState().organizeCursor).toBeUndefined();
    expect(service.getState().unorganizedCount ?? service.getState().messages).toBeTruthy();
    // 沙箱化：日志零新增；附件不被标记为已消化
    expect(service.getState().messages).toHaveLength(before.messages.length);
    expect(service.getState().runSummaries[0]?.snapshotId).toBe(result.runId); // 快照仍建，可回滚
  });

  it('P1 修复：主进程互斥——运行中的第二个 run 被拒绝；项目切换被阻止；完成后复位', async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const blockingModel: ModelAdapter = {
      provider: 'blocking',
      async runTurn(): Promise<ModelTurn> {
        await gate; // 阻塞首个 run，直到测试释放
        return { type: 'final', answer: '完成', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const service = new AppService(() => blockingModel);
    service.createProject(path.join(root, 'proj'), '测试项目');
    service.sendMessage('hi');

    // 第一个 run 阻塞在模型调用上（runActive 已在入口同步置位）
    const first = service.run({ kind: 'chat' });
    // 并发第二个 run → RUN_ALREADY_ACTIVE（chat / organize 同一守卫）
    await expect(service.run({ kind: 'chat' })).rejects.toThrow('RUN_ALREADY_ACTIVE');
    await expect(service.run({ kind: 'chat', scope: { type: 'unorganized' } })).rejects.toThrow('RUN_ALREADY_ACTIVE');
    // 写作/改写任务同样被守卫
    await expect(service.runDetailFill('s1', 'novel')).rejects.toThrow('RUN_ALREADY_ACTIVE');
    // 运行中禁止切换/关闭项目
    expect(() => service.closeProject()).toThrow('RUN_IN_PROGRESS');

    // 释放 → 首个 run 完成，守卫复位，后续 run 正常
    releaseGate();
    await first;
    const again = await service.run({ kind: 'chat' });
    expect(again.error).toBeUndefined();
  });

  it('调用详情（ux-review §4.7）：conversation/runs/<runId>.json 全任务记录', async () => {
    const service = makeService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_node', { nodeId: 'overview' })], usage: usage(5, 1) },
      { type: 'final', answer: '角色一致：林默是侦探。', usage: usage(10, 2) },
      { type: 'final', answer: '林默的侦探设定讨论', usage: usage(5, 1) }, // 会话标题生成（用户反馈 2）
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

    // 用户反馈 2：首个对话 run 完成后 AI 自动命名会话标题（替换「话题 N」占位）
    const session = service.getState().sessions[0];
    expect(session.title).toBe('林默的侦探设定讨论');
    expect(session.titleAuto).toBeFalsy();
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
      { type: 'final', answer: '会话标题', usage: usage(5, 1) }, // 首个 chat run 后的自动命名
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

  it('刷新非 AI 消息抛错；活动路径切换落到最深续写尾（DeepSeek 式版本导航）', async () => {
    const service = makeService([]);
    service.sendMessage('一个问题');
    const state = service.getState();
    await expect(service.refreshMessage(state.messages[0].id)).rejects.toThrow('REFRESH_NOT_AI_MESSAGE');

    service.sendMessage('分支一');
    const s2 = service.getState();
    // 切到 m1（有续写 m2）→ 活动路径落到 m2（m1 的最深续写尾）
    service.switchBranch(s2.messages[0].id);
    expect(service.getState().activeMessageId).toBe(s2.messages[1].id);
    // 叶子消息切换 → 落到自身
    service.switchBranch(s2.messages[1].id);
    expect(service.getState().activeMessageId).toBe(s2.messages[1].id);
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

  it('开启新话题守卫（用户反馈 3）：当前话题为空时不能新建话题', () => {
    const service = makeService([]);
    // 全新项目：活动会话尚无消息 → 拒绝
    expect(() => service.newTopic()).toThrow('TOPIC_EMPTY');
    // 发送首条消息后 → 可新建
    service.sendMessage('第一句话');
    expect(() => service.newTopic()).not.toThrow();
    expect(service.getState().sessions).toHaveLength(2);
  });

  it('AI 自动命名失败时静默保留占位标题（用户反馈 2 降级路径）', async () => {
    const service = makeService([
      { type: 'final', answer: '回答', usage: usage(5, 2) },
      // 标题生成需要的第二个 turn 缺失 → ScriptExhaustedError → 静默保留占位
    ]);
    service.sendMessage('主角是谁');
    await service.run({ kind: 'chat' });
    const session = service.getState().sessions[0];
    expect(session.titleAuto).toBe(true);
    expect(session.title).toMatch(/^话题 \d+$/);
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

describe('app-service — 附件生命周期（Part 1：删除入口）', () => {
  it('删除会话不删附件；附件独立于会话存在（附件是项目一等对象）', () => {
    const service = makeService([]);
    service.addAttachment('旧大纲.txt', '第一章：主角登场');
    const state = service.getState();
    const attachmentId = state.attachments[0].id;
    const session = state.sessions[0];

    service.deleteSession(session.id);
    const after = service.getState();
    expect(after.sessions.find((s) => s.id === session.id)).toBeUndefined();
    // 附件仍在（项目级对象），且引用消息已随会话删除
    expect(after.attachments[0].id).toBe(attachmentId);
    expect(service.readAttachmentContent(attachmentId)).not.toBeNull();
  });

  it('deleteAttachment：从状态移除，正文文件删除，readAttachmentContent 返回 null', () => {
    const service = makeService([]);
    service.addAttachment('旧大纲.txt', '第一章：主角登场');
    const attachmentId = service.getState().attachments[0].id;
    const state = service.deleteAttachment(attachmentId);
    expect(state.attachments).toHaveLength(0);
    expect(service.readAttachmentContent(attachmentId)).toBeNull();
  });

  it('删除附件后，历史引用消息仍保留但附件行隐藏（引用消息内容不变）', () => {
    const service = makeService([]);
    service.addAttachment('旧大纲.txt', '内容');
    const attachmentId = service.getState().attachments[0].id;
    const refMessage = service.getState().messages.find((m) => m.refs?.attachmentIds?.includes(attachmentId))!;
    expect(refMessage).toBeTruthy();

    service.deleteAttachment(attachmentId);
    const after = service.getState();
    expect(after.messages.some((m) => m.id === refMessage.id)).toBe(true);
    expect(after.messages.find((m) => m.id === refMessage.id)!.refs?.attachmentIds).toEqual([attachmentId]);
    expect(after.attachments).toHaveLength(0);
  });
});

describe('app-service — 待发送附件提交（Part 3：sendWithAttachments）', () => {
  it('一次提交：附件逐个落盘并追加引用消息（在前），文本消息（在后）', () => {
    const service = makeService([]);
    const state = service.sendWithAttachments('帮我看看这份大纲', [
      { name: '旧大纲.txt', content: '第一章：主角登场', source: 'uploaded' },
      { name: '设定.md', content: '主角：林默', source: 'workspace' },
    ]);
    expect(state.attachments.map((a) => a.name)).toEqual(['旧大纲.txt', '设定.md']);
    const messages = state.messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('（附件：旧大纲.txt）');
    expect(messages[0].refs?.attachmentIds).toEqual([state.attachments[0].id]);
    expect(messages[1].content).toBe('（附件：设定.md）');
    expect(messages[1].refs?.attachmentIds).toEqual([state.attachments[1].id]);
    expect(messages[2].content).toBe('帮我看看这份大纲');
    expect(messages[2].refs).toBeUndefined();
    // 引用消息不存正文
    expect(messages[0].content).not.toContain('主角登场');
  });

  it('空文本但有附件可发送；空文本且无附件抛 EMPTY_SEND', () => {
    const service = makeService([]);
    const state = service.sendWithAttachments('', [{ name: 'a.txt', content: 'A', source: 'uploaded' }]);
    expect(state.messages).toHaveLength(1);
    expect(() => service.sendWithAttachments('', [])).toThrow('EMPTY_SEND');
  });

  it('归档会话拒绝发送附件（只读守卫）', () => {
    const service = makeService([]);
    service.sendMessage('第一条');
    const session = service.getState().sessions[0];
    service.archiveSession(session.id);
    expect(() => service.sendWithAttachments('x', [{ name: 'a.txt', content: 'A', source: 'uploaded' }])).toThrow('SESSION_ARCHIVED');
  });

  it('readWorkspaceFile：只读项目顶层文本文件；保留文件/系统目录返回 null', () => {
    const service = makeService([]);
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    fs.writeFileSync(path.join(service.dir, '散落笔记.md'), '散落内容', 'utf-8');
    expect(service.readWorkspaceFile('散落笔记.md')).toEqual({ name: '散落笔记.md', content: '散落内容' });
    expect(service.readWorkspaceFile('project.json')).toBeNull();
    expect(service.readWorkspaceFile('nodes')).toBeNull();
    expect(service.readWorkspaceFile('不存在.txt')).toBeNull();
  });
});

describe('app-service — 项目删除（项目级，删除后移到系统回收站）', () => {
  it('非项目目录抛 NOT_A_PROJECT（防误删任意目录）', () => {
    const service = makeService([]);
    const fs = require('fs') as typeof import('fs');
    const root = makeTempDir();
    tempDirs.push(root);
    expect(() => service.deleteProject(root)).toThrow('NOT_A_PROJECT');
    // 目录确实未被删除
    expect(fs.existsSync(root)).toBe(true);
  });

  it('删除未打开的项目：不关闭当前项目，返回 wasOpen=false', () => {
    const service = makeService([]);
    const other = makeTempDir();
    tempDirs.push(other);
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'project.json'), JSON.stringify({ name: '别的项目', createdAt: 't' }), 'utf-8');
    const result = service.deleteProject(other);
    expect(result.wasOpen).toBe(false);
    expect(() => service.getState()).not.toThrow(); // 当前项目仍打开
  });

  it('删除当前打开的项目：先关闭（wasOpen=true），之后状态不可用', () => {
    const service = makeService([]);
    const dir = service.dir;
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: '测试项目', createdAt: 't' }), 'utf-8');
    const result = service.deleteProject(dir);
    expect(result.wasOpen).toBe(true);
    expect(() => service.getState()).toThrow('NO_PROJECT_OPEN');
  });
});

describe('app-service — 附件正文内联（Part 5：首轮上下文直接注入附件内容）', () => {
  it('chat 首次模型输入即含附件完整正文（不再依赖模型主动读取）', async () => {
    const { service, model } = makeRecordingService([
      { type: 'final', answer: '收到。', usage: usage(5, 2) },
      { type: 'final', answer: '标题', usage: usage(5, 1) }, // 自动命名
    ]);
    service.addAttachment('旧大纲.txt', '第一章：主角登场\n第二章：案件发生');
    const result = await service.run({ kind: 'chat' });
    expect(result.error).toBeUndefined();
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('（附件：旧大纲.txt）');
    expect(content).toContain('【附件正文（17 字）】');
    expect(content).toContain('第一章：主角登场');
    expect(content).toContain('第二章：案件发生');
    // 日志仍只存引用（内联是内存视图，不写日志）
    const logMessages = service.getState().messages;
    expect(logMessages.every((m) => !m.content.includes('第一章：主角登场'))).toBe(true);
  });

  it('超过内联上限的附件不内联，提示必须先 read_attachment', async () => {
    const { service, model } = makeRecordingService([
      { type: 'final', answer: '收到。', usage: usage(5, 2) },
      { type: 'final', answer: '标题', usage: usage(5, 1) },
    ]);
    const big = '长'.repeat(12001);
    service.addAttachment('超大材料.md', big);
    await service.run({ kind: 'chat' });
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).not.toContain('【附件正文（12001 字）】');
    expect(content).not.toContain('长'.repeat(100)); // 正文未内联
    expect(content).toContain('过大未内联');
    expect(content).toContain('必须先调用 read_attachment 读取完整正文');
  });

  it('附件已被删除：内联提示缺失，不编造内容', async () => {
    const { service, model } = makeRecordingService([
      { type: 'final', answer: '收到。', usage: usage(5, 2) },
      { type: 'final', answer: '标题', usage: usage(5, 1) },
    ]);
    service.addAttachment('已删材料.txt', '机密内容');
    const attachmentId = service.getState().attachments[0].id;
    service.deleteAttachment(attachmentId);
    await service.run({ kind: 'chat' });
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('附件已被删除');
    expect(content).not.toContain('机密内容');
  });

  it('organize 范围消息同样内联附件正文', async () => {
    const { service, model } = makeRecordingService([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'write_asset', { type: 'character', title: '主角', content: '侦探' })], usage: usage(5, 2) },
      { type: 'final', answer: '已整理。', usage: usage(8, 2) },
    ]);
    service.addAttachment('旧大纲.txt', '第一章：主角登场');
    await service.run({ kind: 'organize', scope: { type: 'unorganized' } });
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('第一章：主角登场');
  });

  it('inspectContext 与调用一致：内联后 token 估算计入附件正文', () => {
    const service = makeService([]);
    const baseline = service.inspectContext();
    service.addAttachment('大纲.txt', '正文内容'.repeat(300));
    const after = service.inspectContext();
    expect(after.estimatedTokens).toBeGreaterThan(baseline.estimatedTokens);
  });

  it('编辑后发送：模型输入只含新文本，旧文本不进上下文', async () => {
    const { service, model } = makeRecordingService([
      { type: 'final', answer: '明白了。', usage: usage(5, 2) },
      { type: 'final', answer: '标题', usage: usage(5, 1) }, // 自动命名
    ]);
    service.sendMessage('原始问题');
    const userMsgId = service.getState().messages[0].id;
    service.editMessage(userMsgId, '修改后的问题');
    const result = await service.run({ kind: 'chat' });
    expect(result.error).toBeUndefined();
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('修改后的问题');
    expect(content).not.toContain('原始问题');
    expect(content).not.toContain('消息已编辑');
  });

  it('存量日志中的「消息已编辑」事件在模型输入中被剔除（兼容旧日志）', async () => {
    const { service, model } = makeRecordingService([
      { type: 'final', answer: '明白了。', usage: usage(5, 2) },
      { type: 'final', answer: '标题', usage: usage(5, 1) },
    ]);
    service.sendMessage('当前问题');
    // 模拟旧版本产生的记账事件：新消息取代它（旧文本 = 已废弃内容）
    const replacement = service.editMessage(service.getState().messages[0].id, '新版本问题');
    service.workspace.conversation.appendMessage({
      id: 'legacy_edit_event',
      role: 'system',
      content: '（消息已编辑）原内容：\n已废弃的旧文本',
      timestamp: 't',
      parentId: replacement.id,
    });
    await service.run({ kind: 'chat' });
    const content = model.inputs[0].messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('新版本问题');
    expect(content).not.toContain('已废弃的旧文本');
    expect(content).not.toContain('消息已编辑');
  });
});

describe('app-service — 设置（全局设置与项目解耦）', () => {
  let settingsDir: string;
  beforeEach(() => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2-svc-settings-'));
    configureSettingsDir(settingsDir);
  });
  afterEach(() => {
    try { fs.rmSync(settingsDir, { recursive: true, force: true }); } catch { /* noop */ }
    configureSettingsDir(undefined);
  });

  it('无项目打开时 updateSettings 不抛错、返回 null，且配置落盘（项目首页换主题回归）', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    // 回归：workspace getter 无项目时抛 NO_PROJECT_OPEN，曾导致换主题静默失败
    const result = service.updateSettings({ theme: 'nebula' });
    expect(result).toBeNull();
    expect(getSettings().theme).toBe('nebula');
  });

  it('有项目打开时 updateSettings 返回项目状态', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    const root = makeTempDir();
    tempDirs.push(root);
    service.createProject(path.join(root, 'proj'), '测试项目');
    const result = service.updateSettings({ theme: 'sakura' });
    expect(result?.settings.theme).toBe('sakura');
  });

  it('chat run 注入全局「最大输出长度」（maxOutputTokens → runTurn options.maxTokens）', async () => {
    saveSettings({ maxOutputTokens: 32768 });
    class OptionsRecordingModel extends ScriptedModelAdapter {
      readonly optionsList: Array<ModelTurnOptions | undefined> = [];
      constructor(script: ScriptedTurn[]) { super(script); }
      async runTurn(input: ModelTurnInput, options?: ModelTurnOptions): Promise<ModelTurn> {
        this.optionsList.push(options);
        return super.runTurn(input, options);
      }
    }
    const model = new OptionsRecordingModel([{ type: 'final', answer: '明白。', usage: usage(5, 2) }]);
    const service = new AppService(() => model);
    const root = makeTempDir();
    tempDirs.push(root);
    service.createProject(path.join(root, 'proj'), '测试项目');
    service.sendMessage('你好');
    await service.run({ kind: 'chat' });
    expect(model.optionsList.length).toBeGreaterThan(0);
    expect(model.optionsList[0]?.maxTokens).toBe(32768);
  });

  it('回答详略档位：detailed → 系统提示含量化规则；concise → 简洁规则；auto → 触发式规则', async () => {
    // detailed
    {
      const { service, model } = makeRecordingService([{ type: 'final', answer: '好', usage: usage(5, 2) }]);
      service.sendMessage('详细评价这段正文');
      await service.run({ kind: 'chat', answerDetail: 'detailed' });
      const prompt = model.inputs[0].systemPrompt;
      expect(prompt).toContain('本次回答要求详细');
      expect(prompt).toContain('不少于 1000 字');
      expect(prompt).toContain('5-8 个维度');
    }
    // concise
    {
      const { service, model } = makeRecordingService([{ type: 'final', answer: '好', usage: usage(5, 2) }]);
      service.sendMessage('详细评价这段正文');
      await service.run({ kind: 'chat', answerDetail: 'concise' });
      const prompt = model.inputs[0].systemPrompt;
      expect(prompt).toContain('本次回答要求简略');
      expect(prompt).toContain('300 字以内');
      expect(prompt).not.toContain('不少于 1000 字');
    }
    // auto（缺省）：保留触发式「回答充分性」，不注入显式档位
    {
      const { service, model } = makeRecordingService([{ type: 'final', answer: '好', usage: usage(5, 2) }]);
      service.sendMessage('你好');
      await service.run({ kind: 'chat' });
      const prompt = model.inputs[0].systemPrompt;
      expect(prompt).toContain('回答充分性');
      expect(prompt).not.toContain('本次回答要求');
    }
  });

  it('setProjectsDir：migrate=true 迁移全部项目到新位置（旧目录删除，重名顺延），设置落盘', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    const root = makeTempDir();
    tempDirs.push(root);
    const oldBase = path.join(root, 'old-projects');
    const newBase = path.join(root, 'new-projects');
    fs.mkdirSync(oldBase, { recursive: true });
    ProjectWorkspace.create(path.join(oldBase, '甲'), '项目甲');
    ProjectWorkspace.create(path.join(oldBase, '乙'), '项目乙');
    fs.mkdirSync(path.join(newBase, '甲'), { recursive: true }); // 预置同名目录 → 新项目应顺延为「甲-2」

    const result = service.setProjectsDir(oldBase, newBase, true);

    expect(result.movedCount).toBe(2);
    expect(result.reopened).toBe(false);
    expect(getSettings().projectsDir).toBe(newBase);
    // 新位置：预置的「甲」空目录保留，迁移副本顺延为「甲-2」，乙直接复制
    expect(fs.existsSync(path.join(newBase, '甲'))).toBe(true); // 预置目录保留
    expect(fs.existsSync(path.join(newBase, '甲', 'project.json'))).toBe(false); // 预置为空目录，未写入
    expect(fs.existsSync(path.join(newBase, '甲-2', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(newBase, '乙', 'project.json'))).toBe(true);
    // 旧位置项目目录已删除（拷贝全部成功后）
    expect(fs.existsSync(path.join(oldBase, '甲'))).toBe(false);
    expect(fs.existsSync(path.join(oldBase, '乙'))).toBe(false);
    // 新位置的项目可被列出
    expect(AppService.listProjects(newBase).map((p) => p.name).sort()).toEqual(['项目乙', '项目甲'].sort());
  });

  it('setProjectsDir：migrate=false 仅切换，旧项目留在原地', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    const root = makeTempDir();
    tempDirs.push(root);
    const oldBase = path.join(root, 'old-projects');
    const newBase = path.join(root, 'new-projects');
    fs.mkdirSync(oldBase, { recursive: true });
    ProjectWorkspace.create(path.join(oldBase, '甲'), '项目甲');

    const result = service.setProjectsDir(oldBase, newBase, false);

    expect(result.movedCount).toBe(0);
    expect(getSettings().projectsDir).toBe(newBase);
    expect(fs.existsSync(path.join(oldBase, '甲', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(newBase, '甲'))).toBe(false);
  });

  it('setProjectsDir：当前打开的项目被搬走 → 自动从新路径重开（reopened=true）', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    const root = makeTempDir();
    tempDirs.push(root);
    const oldBase = path.join(root, 'old-projects');
    const newBase = path.join(root, 'new-projects');
    fs.mkdirSync(oldBase, { recursive: true });
    const projDir = path.join(oldBase, '甲');
    service.createProject(projDir, '项目甲');
    expect(service.dir).toBe(projDir);

    const result = service.setProjectsDir(oldBase, newBase, true);

    expect(result.movedCount).toBe(1);
    expect(result.reopened).toBe(true);
    expect(service.dir).toBe(path.join(newBase, '甲'));
    expect(service.getState().name).toBe('项目甲');
  });

  it('setProjectsDir：相对路径被拒绝；新旧位置相同拒绝迁移', () => {
    const service = new AppService(() => new ScriptedModelAdapter([]));
    const root = makeTempDir();
    tempDirs.push(root);
    const oldBase = path.join(root, 'old-projects');
    fs.mkdirSync(oldBase, { recursive: true });
    ProjectWorkspace.create(path.join(oldBase, '甲'), '项目甲');
    expect(() => service.setProjectsDir(oldBase, 'relative', true)).toThrow('INVALID_PROJECTS_DIR');
    expect(() => service.setProjectsDir(oldBase, oldBase, true)).toThrow('SAME_PROJECTS_DIR');
  });

  it('setProjectsDir：run 进行中拒绝迁移（RUN_IN_PROGRESS 守卫）', async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const blockingModel: ModelAdapter = {
      provider: 'blocking',
      async runTurn(): Promise<ModelTurn> {
        await gate;
        return { type: 'final', answer: '完成', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const service = new AppService(() => blockingModel);
    const oldBase = path.join(root, 'old');
    const newBase = path.join(root, 'new');
    fs.mkdirSync(oldBase, { recursive: true });
    service.createProject(path.join(oldBase, 'proj'), '测试项目');
    service.sendMessage('hi');
    const running = service.run({ kind: 'chat' });

    expect(() => service.setProjectsDir(oldBase, newBase, true)).toThrow('RUN_IN_PROGRESS');
    // 释放 → run 正常完成，守卫复位后迁移可行
    releaseGate();
    await running;
    const result = service.setProjectsDir(oldBase, newBase, true);
    expect(result.movedCount).toBe(1);
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationRepository } from '../../storage/conversation-repository';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ChatMessage } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeConversation(): { conv: ConversationRepository; projectDir: string } {
  const { projectDir } = makeProject();
  tempDirs.push(path.dirname(projectDir));
  return { conv: new ConversationRepository(projectDir), projectDir };
}

function msg(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: `2026-01-01T00:00:0${id.length}.000Z` };
}

describe('conversation-repository — history.jsonl', () => {
  it('appendMessage 追加写入，读取保序返回', () => {
    const { conv } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '第一条'));
    conv.appendMessage(msg('m2', 'ai', '第二条'));
    conv.appendMessage(msg('m3', 'user', '第三条'));
    const messages = conv.readMessages();
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(messages[1].content).toBe('第二条');
    expect(conv.countMessages()).toBe(3);
  });

  it('追加式：不重写已有行（含工具追踪与引用字段完整保留）', () => {
    const { conv, projectDir } = makeConversation();
    conv.appendMessage({
      ...msg('m1', 'ai', '带工具调用'),
      runId: 'run_1',
      toolTrace: [{ toolName: 'search_nodes', args: { q: 'x' }, status: 'completed', timestamp: 't' }],
      refs: { nodeIds: ['n1'], attachmentIds: ['mat_1'] },
    });
    conv.appendMessage(msg('m2', 'user', '下一条'));
    const raw = fs.readFileSync(path.join(projectDir, 'conversation', 'history.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]) as ChatMessage;
    expect(first.toolTrace?.[0].toolName).toBe('search_nodes');
    expect(first.refs?.nodeIds).toEqual(['n1']);
    expect(first.refs?.attachmentIds).toEqual(['mat_1']);
  });

  it('读取容忍末尾损坏行（崩溃残留）', () => {
    const { conv, projectDir } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '完好'));
    fs.appendFileSync(path.join(projectDir, 'conversation', 'history.jsonl'), '{"id": "m2", "role"', 'utf-8');
    const messages = conv.readMessages();
    expect(messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('中间损坏行视为数据错误并抛错', () => {
    const { conv, projectDir } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '完好'));
    fs.appendFileSync(path.join(projectDir, 'conversation', 'history.jsonl'), '{{bad line}}\n', 'utf-8');
    conv.appendMessage(msg('m3', 'user', '又完好'));
    expect(() => conv.readMessages()).toThrow('CONVERSATION_LOG_CORRUPT');
  });

  it('readMessagesFrom 返回指定 id 之后的消息', () => {
    const { conv } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '一'));
    conv.appendMessage(msg('m2', 'user', '二'));
    conv.appendMessage(msg('m3', 'user', '三'));
    expect(conv.readMessagesFrom('m1').map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(conv.readMessagesFrom('m3')).toEqual([]);
    expect(() => conv.readMessagesFrom('ghost')).toThrow('MESSAGE_NOT_FOUND');
  });

  it('getMessage 按 id 查找', () => {
    const { conv } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '一'));
    expect(conv.getMessage('m1')?.content).toBe('一');
    expect(conv.getMessage('ghost')).toBeNull();
  });
});

describe('conversation-repository — 整理光标与 meta', () => {
  it('setOrganizeCursor / getOrganizeCursor 往返', () => {
    const { conv, projectDir } = makeConversation();
    expect(conv.getOrganizeCursor()).toBeUndefined();
    conv.setOrganizeCursor('m_42');
    expect(conv.getOrganizeCursor()).toBe('m_42');
    const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'conversation', 'meta.json'), 'utf-8'));
    expect(meta.lastOrganizedMessageId).toBe('m_42');
  });

  it('updateMeta 部分合并', () => {
    const { conv } = makeConversation();
    conv.setOrganizeCursor('m_1');
    conv.updateMeta({ someFutureField: 'x' } as never);
    expect(conv.getOrganizeCursor()).toBe('m_1');
    expect((conv.readMeta() as Record<string, unknown>).someFutureField).toBe('x');
  });

  it('readUnorganizedMessages：无光标返回全部，有光标返回之后', () => {
    const { conv } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '一'));
    conv.appendMessage(msg('m2', 'user', '二'));
    conv.appendMessage(msg('m3', 'user', '三'));
    expect(conv.readUnorganizedMessages().map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    conv.setOrganizeCursor('m1');
    expect(conv.readUnorganizedMessages().map((m) => m.id)).toEqual(['m2', 'm3']);
    conv.setOrganizeCursor('m3');
    expect(conv.readUnorganizedMessages()).toEqual([]);
  });

  it('光标指向不存在的消息时回退到全文', () => {
    const { conv } = makeConversation();
    conv.appendMessage(msg('m1', 'user', '一'));
    conv.setOrganizeCursor('ghost_cursor');
    expect(conv.readUnorganizedMessages().map((m) => m.id)).toEqual(['m1']);
  });
});

describe('conversation-repository — summary', () => {
  it('writeSummary / readSummary 往返；未写时为空字符串', () => {
    const { conv } = makeConversation();
    expect(conv.readSummary()).toBe('');
    conv.writeSummary('# 摘要\n\n- 决策 A');
    expect(conv.readSummary()).toBe('# 摘要\n\n- 决策 A');
  });
});

describe('conversation-repository — 消息树（§3.2 时间线控制）', () => {
  it('readMessagesWithTree 按 parentId 派生 childrenIds，日志行不被改写', () => {
    const { conv, projectDir } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '根'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '回答 A'), timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ ...msg('m3', 'ai', '回答 B'), timestamp: 't', parentId: 'm1' });
    const tree = conv.readMessagesWithTree();
    expect(tree.find((m) => m.id === 'm1')?.childrenIds).toEqual(['m2', 'm3']);
    expect(conv.getChildren('m1').map((m) => m.id)).toEqual(['m2', 'm3']);
    // 原始行不含 childrenIds（派生字段不落盘）
    const raw = fs.readFileSync(path.join(projectDir, 'conversation', 'history.jsonl'), 'utf-8');
    expect(raw).not.toContain('childrenIds');
  });

  it('supersedesId / supersededBy：刷新后旧回复被标记，原行不改写', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '问题'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '旧回答'), timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ ...msg('m3', 'ai', '新回答'), timestamp: 't', parentId: 'm1', supersedesId: 'm2' });
    const tree = conv.readMessagesWithTree();
    expect(tree.find((m) => m.id === 'm2')?.supersededBy).toBe('m3');
    expect(tree.find((m) => m.id === 'm3')?.supersedesId).toBe('m2');
    expect(conv.getMessage('m2')?.supersededBy).toBeUndefined(); // 原始读取无派生字段
  });

  it('readActivePath 沿 parentId 链回溯；未设活动末端时回退到最新消息', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '一'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '二'), timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ ...msg('m3', 'user', '三'), timestamp: 't', parentId: 'm1' }); // 分支
    conv.appendMessage({ ...msg('m4', 'ai', '四'), timestamp: 't', parentId: 'm3' });
    // 默认：最新消息（m4）所在路径
    expect(conv.readActivePath().map((m) => m.id)).toEqual(['m1', 'm3', 'm4']);
    // 切到分支：活动末端 = m2
    conv.setActiveMessage('m2');
    expect(conv.readActivePath().map((m) => m.id)).toEqual(['m1', 'm2']);
    // setActiveMessage 校验存在性
    expect(() => conv.setActiveMessage('ghost')).toThrow('MESSAGE_NOT_FOUND');
  });

  it('readUnorganizedMessages 沿活动路径计算（§5.3：光标之后、沿活动路径）', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '一'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '二'), timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ ...msg('m3', 'user', '三'), timestamp: 't', parentId: 'm1' }); // 分支
    conv.appendMessage({ ...msg('m4', 'ai', '四'), timestamp: 't', parentId: 'm3' });
    // 活动路径 m1→m3→m4；光标 m1 → 未整理 = [m3, m4]（分支 m2 不在活动路径）
    conv.setOrganizeCursor('m1');
    expect(conv.readUnorganizedMessages().map((m) => m.id)).toEqual(['m3', 'm4']);
    // 切到分支 m2：光标 m4 在另一分支上（不在新活动路径）→ 整条活动路径未整理
    conv.setOrganizeCursor('m4');
    conv.setActiveMessage('m2');
    expect(conv.readUnorganizedMessages().map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('conversation-repository — 会话（ux-review §4.5 ChatGPT 式）', () => {
  it('createSession 新建空会话并设为活动；appendMessage 推进会话 tail 并懒记 root', () => {
    const { conv } = makeConversation();
    // 物化初始会话（有历史消息 → tail = 当前活动路径末端）
    conv.appendMessage({ ...msg('m1', 'user', '话题一'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '回答'), timestamp: 't', parentId: 'm1' });
    conv.ensureInitialSession();
    expect(conv.getActiveSessionId()).toMatch(/^sess_/);
    const s1 = conv.getSession(conv.getActiveSessionId()!)!;
    expect(s1.title).toBe('话题一');
    expect(s1.tailMessageId).toBe('m2');
    expect(s1.rootMessageId).toBe('m1');
    // 新话题：不归档当前，建空会话（tail 未定）→ 活动路径为空
    const s2 = conv.createSession();
    expect(conv.listSessions()).toHaveLength(2);
    expect(s2.tailMessageId).toBeUndefined();
    expect(conv.getActiveSessionId()).toBe(s2.id);
    expect(conv.readActivePath()).toEqual([]);
    // 新话题首条消息：根级（不挂旧话题尾部），懒记 root/tail
    conv.appendMessage({ ...msg('m3', 'user', '话题二'), timestamp: 't' });
    const s2b = conv.getSession(s2.id)!;
    expect(s2b.tailMessageId).toBe('m3');
    expect(s2b.rootMessageId).toBe('m3');
    expect(conv.readActivePath().map((m) => m.id)).toEqual(['m3']);
  });

  it('switchSession 切到会话 tail；空会话 → 空路径；归档/取消归档', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '一'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '二'), timestamp: 't', parentId: 'm1' });
    conv.ensureInitialSession();
    const s1 = conv.getSession(conv.getActiveSessionId()!)!;
    const s2 = conv.createSession('话题 2');

    // 切回话题 1 → 完整链
    conv.switchSession(s1.id);
    expect(conv.getActiveMessageId()).toBe('m2');
    expect(conv.readActivePath().map((m) => m.id)).toEqual(['m1', 'm2']);
    // 切到空话题 2 → 空视图
    conv.switchSession(s2.id);
    expect(conv.readActivePath()).toEqual([]);
    // 归档/取消归档
    conv.archiveSession(s1.id);
    expect(conv.getSession(s1.id)?.archived).toBe(true);
    conv.unarchiveSession(s1.id);
    expect(conv.getSession(s1.id)?.archived).toBeFalsy();
    expect(() => conv.switchSession('ghost')).toThrow('SESSION_NOT_FOUND');
  });

  it('deleteSession：子树（含分支）消息从日志剔除；删活动会话自动切换；无剩余 → 新建', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '话题一'), timestamp: 't' });
    conv.appendMessage({ ...msg('m2', 'ai', '回答一'), timestamp: 't', parentId: 'm1' });
    conv.appendMessage({ ...msg('m3', 'ai', '分支回答'), timestamp: 't', parentId: 'm1', supersedesId: 'm2' }); // 分支
    conv.ensureInitialSession();
    const s1 = conv.getSession(conv.getActiveSessionId()!)!;
    const s2 = conv.createSession('话题 2');
    conv.appendMessage({ ...msg('m4', 'user', '话题二'), timestamp: 't' });
    conv.appendMessage({ ...msg('m5', 'ai', '回答二'), timestamp: 't', parentId: 'm4' });

    // 删除话题 1：m1/m2/m3 全剔除，m4/m5 保留；活动会话自动切到话题 2
    conv.deleteSession(s1.id);
    expect(conv.getSession(s1.id)).toBeNull();
    expect(conv.readMessages().map((m) => m.id)).toEqual(['m4', 'm5']);
    expect(conv.getActiveSessionId()).toBe(s2.id);
    expect(conv.getActiveMessageId()).toBe('m5');

    // 删除唯一剩余会话 → 自动新建空会话
    conv.deleteSession(s2.id);
    expect(conv.readMessages()).toEqual([]);
    expect(conv.getActiveSessionId()).toMatch(/^sess_/);
    expect(conv.readActivePath()).toEqual([]);
  });

  it('ensureInitialSession 幂等；全新项目建空会话', () => {
    const { conv } = makeConversation();
    conv.ensureInitialSession();
    const sid = conv.getActiveSessionId();
    expect(sid).toMatch(/^sess_/);
    expect(conv.getSession(sid!)?.tailMessageId).toBeUndefined();
    // 幂等：再调用不重复建
    conv.ensureInitialSession();
    expect(conv.listSessions()).toHaveLength(1);
  });

  it('会话与整理光标互不影响（光标跨会话全局）', () => {
    const { conv } = makeConversation();
    conv.appendMessage({ ...msg('m1', 'user', '一'), timestamp: 't' });
    conv.ensureInitialSession();
    conv.setOrganizeCursor('m1');
    expect(conv.getOrganizeCursor()).toBe('m1');
    expect(conv.listSessions()).toHaveLength(1);
  });
});

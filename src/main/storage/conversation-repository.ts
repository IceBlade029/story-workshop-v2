/**
 * conversation-repository.ts — 全局对话存储（design doc §3.2、§4.1、§7.1）。
 *
 * conversation/history.jsonl   # 原始对话日志（追加式，永不被改写）
 * conversation/summary.md      # 压缩摘要（派生资产，可被新摘要覆盖）
 * conversation/meta.json       # 对话元数据（整理光标、活动路径、活动会话、会话列表）
 *
 * 原始日志不可变：任何压缩、整理、归档、刷新、编辑都不改写或删除日志行
 * （§7.1）。appendMessage 只追加；读取时容忍末尾一行因崩溃而损坏。
 *
 * 消息树（§3.2）：日志行只持久化不可变指针 parentId / supersedesId；
 * childrenIds / supersededBy 是派生视图（按 parentId / supersedesId 推导），
 * 永不落盘——这保证刷新/编辑分支无需改写旧行。
 */
import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile, writeJsonFile } from '../file-store';
import { writeTextAtomic } from '../atomic-write';
import { generateId } from './id';
import { sha256 } from './hash';
import type { ChatMessage, ConversationMeta, ConversationSession } from '../../shared/types';

export class ConversationRepository {
  constructor(private readonly projectDir: string) {}

  private historyFilePath(): string {
    return path.join(this.projectDir, 'conversation', 'history.jsonl');
  }

  private metaFilePath(): string {
    return path.join(this.projectDir, 'conversation', 'meta.json');
  }

  private summaryFilePath(): string {
    return path.join(this.projectDir, 'conversation', 'summary.md');
  }

  private branchSummaryFilePath(anchorId: string): string {
    return path.join(this.projectDir, 'conversation', 'summaries', `${anchorId}.md`);
  }

  // ---------------------------------------------------------------- history

  /**
   * 追加一条消息到日志末尾。永不改写已有行。
   *
   * 消息树语义（§3.2）：未显式指定 parentId 时自动挂到当前活动路径尾部
   * （连续追加形成线性路径）；opts.root = true 时强制为根级消息。
   * 追加后活动路径末端推进到本条消息（activeMessageId），并同步推进
   * 当前活动会话的 tailMessageId（首条消息顺带记录 rootMessageId）。
   */
  appendMessage(message: ChatMessage, opts?: { root?: boolean }): void {
    const toAppend = { ...message };
    if (opts?.root) {
      delete toAppend.parentId;
    } else if (!toAppend.parentId) {
      // 只挂在显式的活动路径末端（activeMessageId）；未设置 = 根级消息。
      // 不能用 readActivePath 的回退语义（会挂到日志最后一条，误伤新话题）。
      try {
        const tailId = this.readMeta().activeMessageId;
        if (tailId) {
          const tail = this.readMessages().find((m) => m.id === tailId);
          if (tail) toAppend.parentId = tail.id;
        }
      } catch {
        /* 日志损坏：按根级追加 */
      }
    }
    fs.appendFileSync(this.historyFilePath(), JSON.stringify(toAppend) + '\n', 'utf-8');
    this.updateMeta({ activeMessageId: toAppend.id });
    // 同步活动会话尾部（ChatGPT 式会话，ux-review §4.5）
    this.advanceActiveSessionTail(toAppend.id);
  }

  /** 推进活动会话的 tailMessageId（首条消息顺带记录 rootMessageId）。 */
  private advanceActiveSessionTail(messageId: string): void {
    const meta = this.readMeta();
    const sid = meta.activeSessionId;
    if (!sid) return;
    const sessions = meta.sessions ?? [];
    const idx = sessions.findIndex((s) => s.id === sid);
    if (idx < 0) return;
    const session = sessions[idx];
    const next: ConversationSession = {
      ...session,
      tailMessageId: messageId,
      ...(!session.rootMessageId ? { rootMessageId: messageId } : {}),
    };
    const nextSessions = [...sessions];
    nextSessions[idx] = next;
    this.updateMeta({ sessions: nextSessions });
  }

  /** 读取全部消息；损坏的末尾行（崩溃残留）被跳过，其余行按序返回。 */
  readMessages(): ChatMessage[] {
    const filePath = this.historyFilePath();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        // 只有最后一行（未写完的追加）可以被安全忽略；中间的损坏行视为数据错误。
        if (i !== lines.length - 1) throw new Error('CONVERSATION_LOG_CORRUPT');
      }
    }
    return messages;
  }

  /**
   * 读取消息树视图：填充派生字段 childrenIds（parentId === id 的消息）、
   * supersededBy（supersedesId === id 的消息）与版本元数据
   * versionGroupId / versionIndex / versionCount（DeepSeek 式 ◀ i/N ▶ 导航）。
   * 日志行本身不改写。
   */
  readMessagesWithTree(): ChatMessage[] {
    const messages = this.readMessages();
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of messages) {
      if (m.parentId && byId.has(m.parentId)) {
        const parent = byId.get(m.parentId)!;
        parent.childrenIds = [...(parent.childrenIds ?? []), m.id];
      }
      if (m.supersedesId && byId.has(m.supersedesId)) {
        const target = byId.get(m.supersedesId)!;
        target.supersededBy = m.id;
      }
    }
    // 版本组：沿 supersedesId 链回溯根；组内按日志顺序编号（编辑/刷新多次 → 1/3、2/3、3/3）
    const rootOf = new Map<string, string>();
    const chainRoot = (id: string): string => {
      const known = rootOf.get(id);
      if (known) return known;
      const m = byId.get(id);
      const root = m?.supersedesId ? chainRoot(m.supersedesId) : id;
      rootOf.set(id, root);
      return root;
    };
    for (const m of messages) m.versionGroupId = chainRoot(m.id);
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(m.versionGroupId!, (counts.get(m.versionGroupId!) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const m of messages) {
      const index = (seen.get(m.versionGroupId!) ?? 0) + 1;
      seen.set(m.versionGroupId!, index);
      m.versionIndex = index;
      m.versionCount = counts.get(m.versionGroupId!)!;
    }
    return messages;
  }

  /** 某个消息的全部兄弟分支（子消息）。 */
  getChildren(messageId: string): ChatMessage[] {
    const messages = this.readMessagesWithTree();
    const parent = messages.find((m) => m.id === messageId);
    if (!parent || !parent.childrenIds) return [];
    return parent.childrenIds
      .map((id) => messages.find((m) => m.id === id))
      .filter((m): m is ChatMessage => m !== undefined);
  }

  /** 某个 id 之后（不含该 id）的全部消息（按日志顺序）。 */
  readMessagesFrom(afterId: string): ChatMessage[] {
    const messages = this.readMessages();
    const startIdx = messages.findIndex((m) => m.id === afterId);
    if (startIdx < 0) throw new Error(`MESSAGE_NOT_FOUND: ${afterId}`);
    return messages.slice(startIdx + 1);
  }

  countMessages(): number {
    return this.readMessages().length;
  }

  getMessage(messageId: string): ChatMessage | null {
    return this.readMessages().find((m) => m.id === messageId) ?? null;
  }

  // ------------------------------------------------------------ message tree

  /**
   * 活动路径（§3.2）：从 activeMessageId 沿 parentId 链回溯到根再反转。
   * - 活动会话存在但为空（tail 未定，新话题刚建）→ 返回 []（空话题视图）；
   * - 未设置 activeMessageId 且无活动会话（legacy 日志）→ 退回「最后追加的消息所在的路径」。
   */
  readActivePath(): ChatMessage[] {
    const messages = this.readMessagesWithTree();
    const byId = new Map(messages.map((m) => [m.id, m]));
    const meta = this.readMeta();
    let tailId = meta.activeMessageId;
    if (!tailId || !byId.has(tailId)) {
      // 空的新话题：活动会话存在但尚无消息
      if (meta.activeSessionId && !this.getSession(meta.activeSessionId)?.tailMessageId) {
        return [];
      }
      const last = messages.at(-1);
      if (!last) return [];
      tailId = last.id;
    }
    const path: ChatMessage[] = [];
    let current: ChatMessage | undefined = byId.get(tailId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path;
  }

  /** 活动路径末端消息 id；无消息时返回 undefined。 */
  getActiveMessageId(): string | undefined {
    return this.readMeta().activeMessageId;
  }

  setActiveMessage(messageId: string): void {
    if (!this.getMessage(messageId)) throw new Error(`MESSAGE_NOT_FOUND: ${messageId}`);
    // DeepSeek 式版本/分支切换：下探到目标消息的最深续写尾（沿 childrenIds
    // 按日志顺序最后一条递归），使切到中间版本/分支时完整续写链可见，
    // 继续发送自然接在续写链末尾（§3.2 活动路径）。
    const target = this.deepestTailId(messageId);
    this.updateMeta({ activeMessageId: target });
    // 分支切换（刷新/编辑/回看）后，活动路径末端变了 → 同步当前会话尾部。
    // 归档会话完全只读（ux-review §4.5）：尾部冻结，只允许查看，不推进。
    const sid = this.readMeta().activeSessionId;
    if (sid && !(this.getSession(sid)?.archived ?? false)) {
      this.advanceActiveSessionTail(target);
    }
  }

  /** 目标消息沿 childrenIds（日志顺序最后一条）下探到叶子（最深续写尾）。 */
  private deepestTailId(messageId: string): string {
    const byParent = new Map<string, string[]>();
    for (const m of this.readMessages()) {
      if (!m.parentId) continue;
      const list = byParent.get(m.parentId) ?? [];
      list.push(m.id);
      byParent.set(m.parentId, list);
    }
    let current = messageId;
    while (true) {
      const children = byParent.get(current) ?? [];
      if (children.length === 0) return current;
      current = children[children.length - 1];
    }
  }

  // -------------------------------------------------------------------- meta

  readMeta(): ConversationMeta {
    return readJsonFile<ConversationMeta>(this.metaFilePath()) ?? {};
  }

  updateMeta(partial: Partial<ConversationMeta>): void {
    const meta = this.readMeta();
    writeJsonFile(this.metaFilePath(), { ...meta, ...partial });
  }

  /** 推进整理光标（§5.3：任务成功结束后；跨会话全局）。 */
  setOrganizeCursor(messageId: string): void {
    this.updateMeta({ lastOrganizedMessageId: messageId });
  }

  getOrganizeCursor(): string | undefined {
    return this.readMeta().lastOrganizedMessageId;
  }

  /** 当前有效的消息级整理覆盖记录（同 id 内容变化后凭据自动失效）。 */
  getOrganizedMessages(): ConversationMeta['organizedMessages'] {
    return this.readMeta().organizedMessages;
  }

  private messageContentHash(message: ChatMessage): string {
    return sha256(JSON.stringify({
      role: message.role,
      content: message.content,
      refs: message.refs ?? null,
    }));
  }

  /**
   * 记录本次真正消化的消息。首次从旧光标迁移时，把光标之前的活动路径
   * 物化为凭据；之后任意选择产生的空洞都能被准确保留为未整理。
   */
  markMessagesOrganized(messageIds: string[], runId: string): void {
    const meta = this.readMeta();
    const all = this.readMessages();
    const byId = new Map(all.map((m) => [m.id, m]));
    const existing = new Map((meta.organizedMessages ?? []).map((r) => [r.messageId, r]));

    if (!meta.organizedMessages && meta.lastOrganizedMessageId) {
      const path = this.readActivePath();
      const cursorIdx = path.findIndex((m) => m.id === meta.lastOrganizedMessageId);
      if (cursorIdx >= 0) {
        for (const message of path.slice(0, cursorIdx + 1)) {
          if (message.role === 'system') continue;
          existing.set(message.id, {
            messageId: message.id,
            contentHash: this.messageContentHash(message),
            runId: 'legacy-cursor',
            organizedAt: new Date(0).toISOString(),
          });
        }
      }
    }

    const organizedAt = new Date().toISOString();
    for (const id of new Set(messageIds)) {
      const message = byId.get(id);
      if (!message || message.role === 'system') continue;
      existing.set(id, {
        messageId: id,
        contentHash: this.messageContentHash(message),
        runId,
        organizedAt,
      });
    }

    const organizedMessages = [...existing.values()];
    const valid = new Set(
      organizedMessages
        .filter((r) => {
          const message = byId.get(r.messageId);
          return message && this.messageContentHash(message) === r.contentHash;
        })
        .map((r) => r.messageId),
    );
    const active = this.readActivePath().filter((m) => m.role !== 'system');
    let contiguousCursor: string | undefined;
    for (const message of active) {
      if (!valid.has(message.id)) break;
      contiguousCursor = message.id;
    }
    this.updateMeta({ organizedMessages, lastOrganizedMessageId: contiguousCursor });
  }

  /**
   * 读取整理光标之后未整理的消息（§5.3：默认范围 = 光标之后、沿活动路径
   * 未整理的对话）。无光标 = 整条活动路径；光标不在活动路径上（如切到
   * 另一分支后）＝整条活动路径视为未整理，由用户决定是否重新整理。
   *
   * system 事件（运行开始/结束等记账消息）不算未整理内容，排除在外；
   * 光标本身可能指向 system 事件（organize 后光标 = 运行结束事件）。
   */
  readUnorganizedMessages(): ChatMessage[] {
    const meta = this.readMeta();
    if (meta.organizedMessages) {
      const receipts = new Map(meta.organizedMessages.map((r) => [r.messageId, r.contentHash]));
      return this.readActivePath().filter((message) =>
        message.role !== 'system' && receipts.get(message.id) !== this.messageContentHash(message),
      );
    }
    const cursor = this.getOrganizeCursor();
    const fullPath = this.readActivePath();
    const idx = cursor ? fullPath.findIndex((m) => m.id === cursor) : -1;
    const after = idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
    return after.filter((m) => m.role !== 'system');
  }

  // ----------------------------------------------------------------- sessions

  listSessions(): ConversationSession[] {
    return this.readMeta().sessions ?? [];
  }

  getSession(sessionId: string): ConversationSession | null {
    return this.listSessions().find((s) => s.id === sessionId) ?? null;
  }

  getActiveSessionId(): string | undefined {
    return this.readMeta().activeSessionId;
  }

  setActiveSession(sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    this.updateMeta({ activeSessionId: sessionId });
  }

  /**
   * 幂等物化初始会话（ChatGPT 式对话，ux-review §4.5）：
   * - 已有活动会话 → 不做任何事；
   * - 有历史消息 → 物化为「话题 1」（tail = 当前 activeMessageId，旧项目打开连续）；
   * - 全新项目 → 建一个空会话（首条消息落盘时记 root/tail）。
   */
  ensureInitialSession(): void {
    const meta = this.readMeta();
    if (meta.activeSessionId && this.getSession(meta.activeSessionId)) return;
    const messages = this.readMessages();
    const title = this.defaultTitle(messages);
    // 物化已有历史：tail = 当前活动路径末端；root = 从 tail 回溯的根（历史数据可能缺 root）
    let tailMessageId: string | undefined;
    let rootMessageId: string | undefined;
    if (messages.length > 0) {
      tailMessageId = meta.activeMessageId ?? messages.at(-1)!.id;
      const byId = new Map(messages.map((m) => [m.id, m]));
      let current = byId.get(tailMessageId);
      while (current) {
        if (!current.parentId || !byId.has(current.parentId)) {
          rootMessageId = current.id;
          break;
        }
        current = byId.get(current.parentId);
      }
    }
    const session: ConversationSession = {
      id: generateId('sess'),
      title,
      titleAuto: true,
      ...(tailMessageId ? { tailMessageId, rootMessageId } : {}),
      archivedAt: new Date().toISOString(),
    };
    this.updateMeta({
      sessions: [...(meta.sessions ?? []), session],
      activeSessionId: session.id,
      // 物化时若日志有内容但 meta 无 activeMessageId → 兜底到末条
      ...(meta.activeMessageId ? {} : { activeMessageId: messages.length > 0 ? messages.at(-1)!.id : undefined }),
    });
  }

  /** 会话标题：有用户消息取首条用户消息首行，否则「话题 N」。 */
  private defaultTitle(messages: ChatMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      const firstLine = firstUser.content.split('\n')[0].trim().slice(0, 24);
      if (firstLine) return firstLine;
    }
    return `话题 ${this.listSessions().length + 1}`;
  }

  /**
   * 开启新话题（ux-review §4.5）：新建空会话并设为活动。
   * 不归档、不删除当前话题——旧话题保持活跃，可随时切回继续追加。
   */
  createSession(title?: string): ConversationSession {
    const meta = this.readMeta();
    const session: ConversationSession = {
      id: generateId('sess'),
      title: title?.trim() || `话题 ${(meta.sessions ?? []).length + 1}`,
      titleAuto: true,
      archivedAt: new Date().toISOString(),
    };
    this.updateMeta({
      sessions: [...(meta.sessions ?? []), session],
      activeSessionId: session.id,
      activeMessageId: undefined,
    });
    return session;
  }

  /**
   * 切换会话（ChatGPT 式）：活动路径末端 = 该会话 tail。
   * 空会话（tail 未定）→ 活动路径为空（新话题空视图）。
   */
  switchSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    this.updateMeta({ activeSessionId: sessionId, activeMessageId: session.tailMessageId });
  }

  /** 显式归档（ux-review §4.5）：会话完全只读，移入「归档」层级；可取消归档。 */
  archiveSession(sessionId: string): void {
    this.patchSession(sessionId, { archived: true });
  }

  /** 取消归档：移回活跃层，恢复可继续追加。 */
  unarchiveSession(sessionId: string): void {
    this.patchSession(sessionId, { archived: false });
  }

  private patchSession(sessionId: string, patch: Partial<ConversationSession>): void {
    const meta = this.readMeta();
    const sessions = meta.sessions ?? [];
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    const next = [...sessions];
    next[idx] = { ...next[idx], ...patch };
    this.updateMeta({ sessions: next });
  }

  /** AI 自动命名（ChatGPT 式）：写入 AI 生成的标题并清除占位标记。 */
  setSessionTitle(sessionId: string, title: string): void {
    this.patchSession(sessionId, { title, titleAuto: false });
  }

  /**
   * 删除会话（显式操作，确认后永久删除）：从会话列表移除，并把该会话
   * 子树（含分支）的全部消息从日志中剔除（原子重写）。
   * 删除活动会话时自动切到第一个未归档会话；无则新建空会话。
   */
  deleteSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    const meta = this.readMeta();
    const sessions = (meta.sessions ?? []).filter((s) => s.id !== sessionId);

    // 1) 收集该会话子树的全部消息 id（从 root 出发沿 parentId 扩散）
    const messages = this.readMessages();
    const childrenOf = new Map<string | undefined, string[]>();
    for (const m of messages) {
      const list = childrenOf.get(m.parentId) ?? [];
      list.push(m.id);
      childrenOf.set(m.parentId, list);
    }
    const removed = new Set<string>();
    const queue = session.rootMessageId ? [session.rootMessageId] : [];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (removed.has(id)) continue;
      removed.add(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    // tail 悬空但 root 未记（历史数据）时按 tail 兜底
    if (session.tailMessageId && !removed.has(session.tailMessageId)) {
      // 沿 parent 回溯补全该链
      const byId = new Map(messages.map((m) => [m.id, m]));
      let current = byId.get(session.tailMessageId);
      while (current && !removed.has(current.id)) {
        removed.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      // 再扩散一次后代
      const extra = [...removed];
      while (extra.length > 0) {
        const id = extra.pop()!;
        for (const child of childrenOf.get(id) ?? []) {
          if (!removed.has(child)) {
            removed.add(child);
            extra.push(child);
          }
        }
      }
    }

    // 2) 原子重写日志（唯一例外：用户显式删除，§7.1 针对 AI/系统改写）
    const kept = messages.filter((m) => !removed.has(m.id));
    writeTextAtomic(this.historyFilePath(), kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : ''));

    // 3) 活动会话被删 → 切到第一个未归档会话；无 → 新建空会话
    let nextActive = meta.activeSessionId === sessionId ? undefined : meta.activeSessionId;
    if (!nextActive) {
      const first = sessions.find((s) => !s.archived) ?? sessions[0];
      nextActive = first?.id;
    }
    let tail: string | undefined;
    if (nextActive) {
      tail = sessions.find((s) => s.id === nextActive)?.tailMessageId;
    } else {
      const fresh: ConversationSession = {
        id: generateId('sess'),
        title: `话题 ${sessions.length + 1}`,
        archivedAt: new Date().toISOString(),
      };
      sessions.push(fresh);
      nextActive = fresh.id;
    }
    this.updateMeta({
      sessions,
      activeSessionId: nextActive,
      activeMessageId: tail,
    });
  }

  /** 会话的根消息 id（从 tail 回溯；空会话返回 undefined）。 */
  sessionRootMessageId(session: ConversationSession): string | undefined {
    if (session.rootMessageId) return session.rootMessageId;
    if (!session.tailMessageId) return undefined;
    const byId = new Map(this.readMessages().map((m) => [m.id, m]));
    let current = byId.get(session.tailMessageId);
    while (current) {
      if (!current.parentId || !byId.has(current.parentId)) return current.id;
      current = byId.get(current.parentId);
    }
    return undefined;
  }

  // ----------------------------------------------------------------- summary

  writeSummary(content: string): void {
    writeTextAtomic(this.summaryFilePath(), content);
  }

  readSummary(): string {
    try {
      return fs.readFileSync(this.summaryFilePath(), 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * 分支摘要（§7.2、§7.3）：按锚点（被压缩前缀的最后一条消息 id）落盘
   * conversation/summaries/<anchor>.md。分支各自维护摘要，切换后惰性重算；
   * 同锚点重新压缩 = 覆盖（「可被新摘要覆盖」）。
   */
  writeBranchSummary(anchorId: string, content: string): void {
    const dir = path.dirname(this.branchSummaryFilePath(anchorId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeTextAtomic(this.branchSummaryFilePath(anchorId), content);
  }

  readBranchSummary(anchorId: string): string {
    try {
      return fs.readFileSync(this.branchSummaryFilePath(anchorId), 'utf-8');
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ 编辑分支

  /**
   * 编辑用户消息 → 新版本（§3.2）：不原地覆盖。追加一条新用户消息
   * （supersedesId 指向原文，活动路径从该点截断重走），原文保留为旧版本
   * （◀ ▶ 版本导航查看）。不追加「消息已编辑」记账事件——旧文本由被取代
   * 消息本身保留在日志，编辑后进入模型上下文的新版本不应携带旧文本
   * （防止模型收到编辑前的旧内容）。原始日志永不改写（§7.1）。
   */
  editMessage(messageId: string, newContent: string): ChatMessage {
    const target = this.getMessage(messageId);
    if (!target) throw new Error(`MESSAGE_NOT_FOUND: ${messageId}`);
    if (target.role !== 'user') throw new Error('EDIT_NOT_USER_MESSAGE');
    if (newContent.trim() === '' || newContent === target.content) {
      throw new Error('EDIT_EMPTY_OR_UNCHANGED');
    }
    const now = new Date().toISOString();
    const replacement: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content: newContent,
      timestamp: now,
      parentId: target.parentId,
      supersedesId: messageId,
      refs: target.refs,
    };
    // 根级消息的替换必须显式保持根级：appendMessage 对无 parentId 的消息
    // 会自动挂到活动路径末端（即原文自身）——那会让旧版本变成新版本的父亲，
    // 旧文本随之进入模型上下文。
    this.appendMessage(replacement, { root: target.parentId === undefined });
    // 尾部已由 appendMessage 推进（活动路径 = 新版本，与会话 tail 一致）
    return replacement;
  }
}

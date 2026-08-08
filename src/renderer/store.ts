/**
 * store.ts — 渲染层状态存储（useSyncExternalStore）。
 *
 * 数据权威在主进程（AppService + 磁盘）；渲染层每次操作后刷新
 * project:state。run 的流式事件走 push 通道，存 activeRun 供界面展示。
 */
import { useSyncExternalStore } from 'react';
import { getApi } from './api';
import { applyTheme } from './theme';
import { confirmDiscardDialog } from './components/ui/dialog';
import type { ProjectState, RunStreamEvent, NodeContent, OutputInfo, ContextInspection, NodeVersion, FileDiff, RunSummaryEntry, OutputVersion, ExportBookResult, GlobalSearchResult } from '../shared/ipc-types';
import type { AppSettings, AnswerDetail } from '../shared/llm-types';
import type { ChatMessage, ToolCallTrace, VisibleView } from '../shared/types';

export type TabId = 'outline' | 'assets' | 'sessions' | 'trash';
/** 顶层模块（ux-review §2：两个对等全屏模块） */
export type ModuleId = 'discussion' | 'writing';
/** 右栏职责收敛（ux-review §4.6）：只保留知识库对象详情查看 */
export type WorkspaceMode = 'node' | 'asset';
export type ToastKind = 'info' | 'success' | 'error';

/** 待发送附件（Part 3：上传先入输入框上方暂存区，发送时才落盘进对话）。 */
export interface PendingAttachment {
  key: string;
  name: string;
  content: string;
  source: 'uploaded' | 'workspace' | 'pasted';
  size: number;
}

let pendingKeySeq = 0;
export function nextPendingKey(): string {
  pendingKeySeq += 1;
  return `pending-${Date.now()}-${pendingKeySeq}`;
}

/** 长文本自动识别为附件的阈值（≈2000 字，§3.2）。 */
export const LONG_TEXT_THRESHOLD = 2000;

/** 运行完成兜底（毫秒）：流式事件推送异常时主动刷新状态，绝不永远「思考中…」 */
const RUN_COMPLETION_FALLBACK_MS = 60_000;
export type RunKind = 'chat' | 'organize' | 'detail_fill' | 'revise';

/** 一次 run 的启动参数（错误/取消后「重试」用，ux-review §4.1）。 */
export type RunRequestParams =
  | { kind: 'chat'; parentMessageId?: string; answerDetail?: AnswerDetail }
  | { kind: 'organize'; scope?: import('../shared/ipc-types').OrganizeScope; note?: string }
  | { kind: 'detail_fill'; sceneId: string; format: string; feedback?: string }
  | { kind: 'revise'; sceneId: string; format: string; start: number; end: number; instruction: string }
  | { kind: 'refresh'; messageId: string; answerDetail?: AnswerDetail };

export interface ActiveRun {
  runId: string;
  kind: RunKind;
  chunks: string[];
  /** 思维链（DeepSeek V4 思考模式，流式增量累积） */
  reasoning: string[];
  /** 服务端联网搜索状态（Responses API 原生 web_search） */
  searching: boolean;
  traces: ToolCallTrace[];
  status: 'running' | 'done' | 'error';
  error?: string;
  finalAnswer?: string;
  /** 重试参数（§4.1：消息流内错误呈现 + 重试按钮） */
  retry?: RunRequestParams;
}

export interface AppState {
  project: ProjectState | null;
  projects: Array<{ dir: string; name: string; createdAt: string }>;
  /** 顶层模块（ux-review §2：讨论 / 正文），切换不丢模块内状态 */
  module: ModuleId;
  /** 正文模块当前选中的场景（§5.1；与讨论模块选中节点互相独立） */
  writingSceneId: string | null;
  tab: TabId;
  selected: { kind: 'node' | 'asset'; id: string } | null;
  workspaceMode: WorkspaceMode | null;
  /**
   * 查看历史栈（ux-review §4.6）：左栏选择直接替换不压栈；跳转类操作
   * （总结消息节点链接 / 正文模块打开场景）压栈，右栏「←」回到跳转前对象。
   */
  viewHistory: Array<{ kind: 'node' | 'asset'; id: string }>;
  inputText: string;
  /** 待发送附件（Part 3：上传先暂存在输入框上方，发送时才落盘进对话） */
  pendingAttachments: PendingAttachment[];
  activeRun: ActiveRun | null;
  lastRunId: string | null;
  /**
   * 正在被「重新生成」的消息 id（DeepSeek 式就地替换）：刷新 run 进行中时
   * 该消息立即被流式卡片替换，完成后新版本接管（旧版进 ◀ ▶ 版本导航）。
   */
  refreshingMessageId: string | null;
  /** 全局搜索「正文/可见视图」跳转的待应用格式（§6.9：WritingModule 消费后清除） */
  pendingWritingFormat: string | null;
  /** 最近一次写作任务（detail_fill / revise）的内部 runId（沙箱隔离后写作任务
   * 在讨论中零痕迹；正文模块工具栏「ⓘ 调用详情」入口用，ux-review §4.7）。
   */
  lastWritingRunId: string | null;
  /**
   * 最近一次整理任务的瞬态结果（Part 4：organize 沙箱化后不写对话日志，
   * 结果以子栏卡片展示；重启后消失，历史由调用详情记录兜底）。
   * P1 修复：失败/取消的整理同样进卡片（failed），提供「部分写入详情 + 回滚」
   * 恢复入口——快照与变更摘要已为失败 run 落盘。
   */
  lastOrganize: { runId: string; finalAnswer: string; failed?: boolean; error?: string } | null;
  toast: { message: string; kind: ToastKind } | null;
  /** 大纲树展开状态（§3.1，切 tab 不丢） */
  expandedIds: Set<string>;
  /** 大纲树搜索词 */
  treeSearch: string;
  /** 讨论模块左栏折叠（§6.12：一键折叠腾出对话空间） */
  leftCollapsed: boolean;
  /** 讨论模块右栏折叠 */
  rightCollapsed: boolean;
  /** 写作模块场景树折叠 */
  scenesCollapsed: boolean;
  /** 回答详略档位（聊天工具栏每次发送可选；localStorage 记忆上次选择） */
  answerDetail: AnswerDetail;
  /**
   * 派生视图（随 project 缓存，useSyncExternalStore 需要稳定引用）：
   * 活动路径消息 + 光标后未整理计数（§5.3）。
   */
  activePath: ChatMessage[];
  unorganizedCount: number;
}

const initial: AppState = {
  project: null,
  projects: [],
  module: 'discussion',
  writingSceneId: null,
  tab: 'outline',
  selected: null,
  workspaceMode: null,
  viewHistory: [],
  inputText: '',
  pendingAttachments: [],
  activeRun: null,
  lastRunId: null,
  refreshingMessageId: null,
  pendingWritingFormat: null,
  lastWritingRunId: null,
  lastOrganize: null,
  toast: null,
  expandedIds: new Set(),
  treeSearch: '',
  leftCollapsed: false,
  rightCollapsed: false,
  scenesCollapsed: false,
  answerDetail: 'auto',
  activePath: [],
  unorganizedCount: 0,
};

/** 折叠状态持久化（§6.12：跨模块/跨项目保持；与列宽同存 localStorage）。 */
const COLLAPSED_KEY = 'sw2:collapsed';

/** 回答详略档位记忆（聊天工具栏选择，跨会话保持）。 */
const ANSWER_DETAIL_KEY = 'sw2:answer-detail';

function loadAnswerDetail(): AnswerDetail {
  try {
    const raw = localStorage.getItem(ANSWER_DETAIL_KEY);
    if (raw === 'concise' || raw === 'auto' || raw === 'detailed') return raw;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return 'auto';
}

function persistAnswerDetail(detail: AnswerDetail): void {
  try {
    localStorage.setItem(ANSWER_DETAIL_KEY, detail);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function loadCollapsed(): { leftCollapsed: boolean; rightCollapsed: boolean; scenesCollapsed: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Partial<Record<'left' | 'right' | 'scenes', boolean>>;
    return {
      leftCollapsed: raw.left === true,
      rightCollapsed: raw.right === true,
      scenesCollapsed: raw.scenes === true,
    };
  } catch {
    return { leftCollapsed: false, rightCollapsed: false, scenesCollapsed: false };
  }
}

function persistCollapsed(s: AppState): void {
  try {
    localStorage.setItem(
      COLLAPSED_KEY,
      JSON.stringify({ left: s.leftCollapsed, right: s.rightCollapsed, scenes: s.scenesCollapsed }),
    );
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

let state: AppState = initial;
const listeners = new Set<() => void>();

/** 派生缓存：project 引用不变时复用同一份数组（getSnapshot 稳定性）。 */
let derivedCache: { project: ProjectState | null; activePath: ChatMessage[]; unorganizedCount: number } = {
  project: null,
  activePath: [],
  unorganizedCount: 0,
};

function computeDerived(project: ProjectState | null): { activePath: ChatMessage[]; unorganizedCount: number } {
  if (!project) return { activePath: [], unorganizedCount: 0 };
  const byId = new Map(project.messages.map((m) => [m.id, m]));
  let tailId = project.activeMessageId;
  if (!tailId || !byId.has(tailId)) {
    // 空的新话题（ux-review §4.5）：活动会话存在但尚无消息 → 空视图，不误兜底全局最后一条
    const activeSession = project.sessions.find((s) => s.id === project.activeSessionId);
    if (activeSession && !activeSession.tailMessageId) {
      return { activePath: [], unorganizedCount: 0 };
    }
    const last = project.messages.at(-1);
    if (!last) return { activePath: [], unorganizedCount: 0 };
    tailId = last.id;
  }
  const path: ChatMessage[] = [];
  let current = byId.get(tailId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // 与主进程一致：system 事件不计入未整理
  let unorganizedCount: number;
  if (project.organizeCursor) {
    const idx = path.findIndex((m) => m.id === project.organizeCursor);
    unorganizedCount = idx >= 0
      ? path.slice(idx + 1).filter((m) => m.role !== 'system').length
      : path.filter((m) => m.role !== 'system').length;
  } else {
    unorganizedCount = path.filter((m) => m.role !== 'system').length;
  }
  return { activePath: path, unorganizedCount };
}

function applyDerived(s: AppState): AppState {
  if (s.project === derivedCache.project) {
    return { ...s, activePath: derivedCache.activePath, unorganizedCount: derivedCache.unorganizedCount };
  }
  const d = computeDerived(s.project);
  derivedCache = { project: s.project, activePath: d.activePath, unorganizedCount: d.unorganizedCount };
  return { ...s, ...d };
}

function setState(patch: Partial<AppState>): void {
  state = applyDerived({ ...state, ...patch });
  persistCollapsed(state);
  for (const l of listeners) l();
}

/**
 * 完成兜底：done 事件可能因推送链路异常丢失（webContents 销毁/广播失败）。
 * 超时后主动刷新项目状态——
 * - 对话任务（chat/organize）：若对话日志里已出现该 run 的 AI 消息，说明已完成，收尾展示；
 * - 写作任务（detail_fill/revise，沙箱隔离后对话中零痕迹）：直接清掉运行指示并刷新状态
 *   （主进程 run 照常落盘 outputs/，正文模块重新读取即可）。
 */
function scheduleRunFallback(runId: string): void {
  setTimeout(() => {
    void (async () => {
      const run = store.getState().activeRun;
      if (!run || run.runId !== runId || run.status !== 'running') return;
      try {
        const project = await getApi().state.get();
        if (run.kind === 'chat' || run.kind === 'organize') {
          const completed = project.messages.some((m) => m.role === 'ai' && m.runId === runId);
          if (completed) {
            withState((s) => ({ ...s, project, activeRun: null, refreshingMessageId: null }));
            store.showToast('运行已完成，结果已刷新', 'info');
          }
        } else {
          withState((s) => ({ ...s, project, activeRun: null, refreshingMessageId: null }));
          store.showToast('正文任务已完成，结果已刷新', 'info');
        }
      } catch {
        /* 保持运行中 */
      }
    })();
  }, RUN_COMPLETION_FALLBACK_MS);
}

function withState<T>(next: (s: AppState) => AppState): void {
  state = applyDerived(next(state));
  persistCollapsed(state);
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// 未保存保护（ux-review §6.8）：编辑器脏状态守卫注册表
// 每个编辑器（正文/草稿/设定/可见视图）mount 时注册、unmount 时注销；
// 导航（切节点/场景/格式/跳转）前检查受影响编辑器的脏状态，弹三选一确认。
// ---------------------------------------------------------------------------

export interface EditorGuard {
  /** 唯一键（如 draft:<nodeId> / output:<sceneId>:<format> / asset:<id> / view:<sceneId>） */
  key: string;
  /** 当前是否有未保存修改（用 ref 读取，避免闭包陈旧） */
  isDirty: () => boolean;
  /** 保存当前内容；返回是否成功（失败则不继续导航） */
  save: () => Promise<boolean>;
}

const dirtyEditors = new Map<string, EditorGuard>();

export function registerEditorGuard(guard: EditorGuard): () => void {
  dirtyEditors.set(guard.key, guard);
  return () => {
    if (dirtyEditors.get(guard.key) === guard) dirtyEditors.delete(guard.key);
  };
}

function hasAnyDirty(): boolean {
  for (const g of dirtyEditors.values()) if (g.isDirty()) return true;
  return false;
}

/**
 * 离开守卫：本次切换会使 match 命中的编辑器失去内容（reload/卸载）。
 * 对每个受影响且脏的编辑器依次弹三选一确认；任一「取消」或「保存失败」→ false。
 */
async function guardBeforeLeave(match: (key: string) => boolean): Promise<boolean> {
  for (const g of dirtyEditors.values()) {
    if (!match(g.key) || !g.isDirty()) continue;
    const choice = await confirmDiscardDialog({
      title: '有未保存的修改',
      message: '切换后当前编辑内容将丢失。',
      confirmText: '保存并继续',
      discardText: '放弃修改',
      cancelText: '取消',
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      const ok = await g.save();
      if (!ok) return false; // 保存失败：不导航，用户保留本地内容重试
    }
  }
  return true;
}

export const store = {
  getState(): AppState {
    return state;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** 测试用：重置到初始状态。 */
  reset(): void {
    state = { ...initial };
    derivedCache = { project: null, activePath: [], unorganizedCount: 0 };
    for (const l of listeners) l();
  },

  // ------------------------------------------------------------ actions

  async loadProjects(): Promise<void> {
    const api = getApi();
    const projects = await api.project.list();
    setState({ projects });
  },

  async createProject(name: string): Promise<void> {
    const api = getApi();
    const project = await api.project.create(name);
    setState({ project, selected: null, workspaceMode: null });
  },

  async openProject(dir: string): Promise<void> {
    const api = getApi();
    const project = await api.project.open(dir);
    setState({ project, selected: null, workspaceMode: null });
  },

  async pickAndOpen(): Promise<void> {
    const api = getApi();
    const dir = await api.project.pickFolder();
    if (dir) await this.openProject(dir);
  },

  /** 返回项目列表（§6.10：TopBar 项目菜单）。切换前未保存保护由调用方确认。 */
  async backToProjects(): Promise<void> {
    setState({
      project: null,
      activeRun: null,
      refreshingMessageId: null,
      lastRunId: null,
      lastWritingRunId: null,
      lastOrganize: null,
      pendingAttachments: [],
      inputText: '',
      selected: null,
      workspaceMode: null,
      viewHistory: [],
      writingSceneId: null,
    });
    await this.loadProjects();
  },

  /** 重命名当前项目（仅更新 project.json 名称）。 */
  async renameProject(name: string): Promise<void> {
    const dir = state.project?.dir;
    if (!dir) throw new Error('NO_PROJECT_OPEN');
    const api = getApi();
    await api.project.rename(dir, name);
    const project = await api.state.get();
    setState({ project });
  },

  /**
   * 删除项目（确认后移到系统回收站）：若删除的是当前打开项目 → 自动关闭并
   * 回到项目列表；随后刷新列表。
   */
  async deleteProject(dir: string): Promise<void> {
    const api = getApi();
    await api.project.delete(dir);
    const wasOpen = state.project?.dir === dir;
    if (wasOpen) {
      setState({
        project: null,
        activeRun: null,
        refreshingMessageId: null,
        lastRunId: null,
        lastWritingRunId: null,
        lastOrganize: null,
        pendingAttachments: [],
        inputText: '',
        selected: null,
        workspaceMode: null,
        viewHistory: [],
      });
    }
    await this.loadProjects();
  },

  /** 任意操作后刷新项目状态（IPC 操作都返回新 state，直接使用）。 */
  adoptProject(project: ProjectState): void {
    setState({ project });
  },

  setTab(tab: TabId): void {
    setState({ tab });
  },

  /** 启动时恢复折叠偏好（§6.12，localStorage）。 */
  initCollapsed(): void {
    setState(loadCollapsed());
  },

  /** 启动时恢复回答详略档位（聊天工具栏，localStorage 记忆）。 */
  initAnswerDetail(): void {
    setState({ answerDetail: loadAnswerDetail() });
  },

  /** 设置回答详略档位（每次发送可选；记忆上次选择）。 */
  setAnswerDetail(detail: AnswerDetail): void {
    setState({ answerDetail: detail });
    persistAnswerDetail(detail);
  },

  /** 讨论模块左栏折叠切换（§6.12）。 */
  toggleLeftPanel(): void {
    withState((s) => ({ ...s, leftCollapsed: !s.leftCollapsed }));
  },

  /** 讨论模块右栏折叠切换。 */
  toggleRightPanel(): void {
    withState((s) => ({ ...s, rightCollapsed: !s.rightCollapsed }));
  },

  /** 写作模块场景树折叠切换。 */
  toggleScenes(): void {
    withState((s) => ({ ...s, scenesCollapsed: !s.scenesCollapsed }));
  },

  /** 专注写作模式（§6.12）：三栏全部折叠/全部展开。 */
  toggleFocus(): void {
    withState((s) => {
      const allCollapsed = s.leftCollapsed && s.rightCollapsed && s.scenesCollapsed;
      return {
        ...s,
        leftCollapsed: !allCollapsed,
        rightCollapsed: !allCollapsed,
        scenesCollapsed: !allCollapsed,
      };
    });
  },

  /** 切换顶层模块（ux-review §2：讨论 / 正文）；模块内状态互相独立。 */
  setModule(module: ModuleId): void {
    setState({ module });
  },

  /** 正文模块内选择场景（§5.1 树形导航；与讨论模块选中节点互相独立）。 */
  async setWritingScene(sceneId: string): Promise<void> {
    const current = state.writingSceneId;
    if (current && current !== sceneId) {
      const ok = await guardBeforeLeave((key) => key.startsWith(`output:${current}:`) || key.startsWith(`view:${current}`));
      if (!ok) return;
    }
    setState({ writingSceneId: sceneId });
  },

  /** 全局搜索跳转（§6.9）：切到正文模块并选中场景；format 非空则待应用。 */
  setWritingTarget(sceneId: string, format: string): void {
    void this.setWritingScene(sceneId);
    if (format) withState((s) => ({ ...s, pendingWritingFormat: format }));
  },

  /** 消费完毕清除待应用格式（§6.9：WritingModule 应用后调用）。 */
  clearPendingWritingFormat(): void {
    if (state.pendingWritingFormat) setState({ pendingWritingFormat: null });
  },

  /** 大纲树展开状态（§3.1）。 */
  toggleExpanded(nodeId: string): void {
    withState((s) => {
      const next = new Set(s.expandedIds);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { ...s, expandedIds: next };
    });
  },

  setTreeSearch(query: string): void {
    setState({ treeSearch: query });
  },

  /** 选择大纲节点/设定（ux-review §4.6：左栏选择直接替换，不压历史栈）。 */
  async selectNode(nodeId: string): Promise<void> {
    const current = state.selected;
    if (current?.kind === 'node' && current.id !== nodeId) {
      const ok = await guardBeforeLeave((key) => key.startsWith(`draft:${current.id}`));
      if (!ok) return;
    }
    setState({ selected: { kind: 'node', id: nodeId }, workspaceMode: 'node' });
  },

  async selectAsset(assetId: string): Promise<void> {
    const current = state.selected;
    if (current?.kind === 'asset' && current.id !== assetId) {
      const ok = await guardBeforeLeave((key) => key === `asset:${current.id}`);
      if (!ok) return;
    }
    setState({ selected: { kind: 'asset', id: assetId }, workspaceMode: 'asset' });
  },

  /**
   * 跳转类操作（ux-review §4.6）：对话流链接 / 正文模块「打开」→ 压入
   * 历史栈（回到跳转前正在查看的对象），再选中目标。
   */
  async jumpTo(kind: 'node' | 'asset', id: string): Promise<void> {
    const current = state.selected;
    if (current && current.id !== id) {
      const ok = await guardBeforeLeave((key) =>
        current.kind === 'node' ? key.startsWith(`draft:${current.id}`) : key === `asset:${current.id}`);
      if (!ok) return;
    }
    withState((s) => {
      const next: Array<{ kind: 'node' | 'asset'; id: string }> = current ? [...s.viewHistory, current] : s.viewHistory;
      return {
        ...s,
        viewHistory: next,
        selected: { kind, id },
        workspaceMode: kind,
      };
    });
  },

  /** 回退：跳到跳转前正在查看的对象（右栏「←」，§4.6）。 */
  async viewBack(): Promise<void> {
    const current = state.selected;
    if (current) {
      const ok = await guardBeforeLeave((key) =>
        current.kind === 'node' ? key.startsWith(`draft:${current.id}`) : key === `asset:${current.id}`);
      if (!ok) return;
    }
    withState((s) => {
      if (s.viewHistory.length === 0) return s;
      const prev = s.viewHistory[s.viewHistory.length - 1];
      return {
        ...s,
        viewHistory: s.viewHistory.slice(0, -1),
        selected: prev,
        workspaceMode: prev.kind,
      };
    });
  },

  setWorkspaceMode(mode: WorkspaceMode | null): void {
    setState({ workspaceMode: mode });
  },

  setInputText(text: string): void {
    setState({ inputText: text });
  },


  showToast(message: string | null, kind: ToastKind = 'info'): void {
    setState({ toast: message ? { message, kind } : null });
    if (message) {
      setTimeout(() => {
        withState((s) => (s.toast?.message === message ? { ...s, toast: null } : s));
      }, 3200);
    }
  },

  // ------------------------------------------------------------ 对话

  /** 发送用户消息，随后启动 chat run。 */
  async sendAndRun(content: string): Promise<void> {
    const api = getApi();
    setState({ inputText: '' });
    const project = await api.conversation.send(content);
    setState({ project });
    await this.startRun('chat', { parentMessageId: project.activeMessageId, answerDetail: state.answerDetail });
  },

  /**
   * 发送「文本 + 待发送附件」（Part 3，ChatGPT 式）：附件发送时才落盘进对话。
   * 长文本（≥ LONG_TEXT_THRESHOLD）自动转为 pasted 附件；空文本但有附件也可发送。
   */
  async sendWithPending(text: string): Promise<void> {
    const api = getApi();
    const trimmed = text.trim();
    if (trimmed === '' && state.pendingAttachments.length === 0) return;
    const attachments: Array<{ name: string; content: string; source: 'pasted' | 'uploaded' | 'workspace' }> =
      state.pendingAttachments.map((a) => ({ name: a.name, content: a.content, source: a.source }));
    let content = trimmed;
    if (trimmed.length >= LONG_TEXT_THRESHOLD) {
      const name = trimmed.split('\n')[0].slice(0, 30) || '粘贴文本.md';
      attachments.push({ name, content: trimmed, source: 'pasted' });
      content = '';
    }
    setState({ inputText: '', pendingAttachments: [] });
    const project = await api.conversation.sendWithAttachments(content, attachments);
    setState({ project });
    await this.startRun('chat', { parentMessageId: project.activeMessageId, answerDetail: state.answerDetail });
  },

  async organize(scope?: 'unorganized' | 'all', note?: string): Promise<void> {
    await this.startRun('organize', { scope: scope === 'all' ? { type: 'all' } : { type: 'unorganized' }, note });
  },

  async startRun(kind: 'chat' | 'organize', req: { parentMessageId?: string; scope?: import('../shared/ipc-types').OrganizeScope; note?: string; answerDetail?: AnswerDetail }): Promise<void> {
    const api = getApi();
    const { runId } = await api.run.start({ kind, ...req });
    const retry: RunRequestParams = kind === 'chat'
      ? { kind: 'chat', parentMessageId: req.parentMessageId, answerDetail: req.answerDetail }
      : { kind: 'organize', scope: req.scope ?? { type: 'unorganized' }, note: req.note };
    withState((s) => ({ ...s, refreshingMessageId: null, activeRun: { runId, kind, chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry } }));
    scheduleRunFallback(runId);
  },

  /** 刷新最后一条 AI 消息（重新生成，生成新版本 ◀ ▶ 可切换）。
   * 旧回答立即被流式卡片就地替换（refreshingMessageId），完成后新版本接管。
   * 档位使用当前选择器值（用户可先调档位再重新生成）。 */
  async refreshMessage(messageId: string): Promise<void> {
    const api = getApi();
    if (state.activeRun?.status === 'running') throw new Error('RUN_IN_PROGRESS: 运行中不能重新生成，请先等待完成或取消');
    const detail = state.answerDetail;
    const { runId } = await api.run.refresh(messageId, detail);
    withState((s) => ({
      ...s,
      refreshingMessageId: messageId,
      activeRun: { runId, kind: 'chat', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: { kind: 'refresh', messageId, answerDetail: detail } },
    }));
    scheduleRunFallback(runId);
  },

  /** 正文生成（§6.5）：可见视图 → 正文 → outputs 落盘。 */
  async detailFill(sceneId: string, format: string, feedback?: string): Promise<void> {
    const api = getApi();
    const { runId } = await api.run.detailFill(sceneId, format, feedback);
    withState((s) => ({
      ...s,
      activeRun: {
        runId, kind: 'detail_fill', chunks: [], reasoning: [], searching: false, traces: [], status: 'running',
        retry: { kind: 'detail_fill', sceneId, format, feedback },
      },
    }));
    scheduleRunFallback(runId);
  },

  /** 就地改写（§5.3）：启动 revise run，模型返回选中区间的完整替换文本。 */
  async revise(sceneId: string, format: string, start: number, end: number, instruction: string): Promise<void> {
    const api = getApi();
    const { runId } = await api.run.revise(sceneId, format, start, end, instruction);
    withState((s) => ({
      ...s,
      activeRun: {
        runId, kind: 'revise', chunks: [], reasoning: [], searching: false, traces: [], status: 'running',
        retry: { kind: 'revise', sceneId, format, start, end, instruction },
      },
    }));
    scheduleRunFallback(runId);
  },

  /** 接受改写（§5.3）：本地替换落盘 + 快照 + 对话流轻提示。 */
  async applyRevise(sceneId: string, format: string, start: number, end: number, replacement: string): Promise<void> {
    const api = getApi();
    const project = await api.output.applyRevise(sceneId, format, start, end, replacement);
    setState({ project });
  },

  /** 撤销上次改写（§5.3：单级）。 */
  async undoRevise(sceneId: string, format: string): Promise<void> {
    const api = getApi();
    const project = await api.output.undoRevise(sceneId, format);
    setState({ project });
  },

  /** 重试（ux-review §4.1：消息流内错误呈现 + 重试按钮；取消/出错后复用原参数）。 */
  async retryRun(): Promise<void> {
    const params = state.activeRun?.retry;
    if (!params) return;
    switch (params.kind) {
      case 'chat': {
        const { runId } = await getApi().run.start({ kind: 'chat', parentMessageId: params.parentMessageId, answerDetail: params.answerDetail });
        withState((s) => ({ ...s, activeRun: { runId, kind: 'chat', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: params } }));
        scheduleRunFallback(runId);
        break;
      }
      case 'organize': {
        const { runId } = await getApi().run.start({ kind: 'organize', scope: params.scope ?? { type: 'unorganized' }, note: params.note });
        withState((s) => ({ ...s, activeRun: { runId, kind: 'organize', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: params } }));
        scheduleRunFallback(runId);
        break;
      }
      case 'detail_fill': {
        const { runId } = await getApi().run.detailFill(params.sceneId, params.format, params.feedback);
        withState((s) => ({ ...s, activeRun: { runId, kind: 'detail_fill', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: params } }));
        scheduleRunFallback(runId);
        break;
      }
      case 'refresh': {
        const { runId } = await getApi().run.refresh(params.messageId, params.answerDetail);
        withState((s) => ({ ...s, refreshingMessageId: params.messageId, activeRun: { runId, kind: 'chat', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: params } }));
        scheduleRunFallback(runId);
        break;
      }
      case 'revise': {
        const { runId } = await getApi().run.revise(params.sceneId, params.format, params.start, params.end, params.instruction);
        withState((s) => ({ ...s, activeRun: { runId, kind: 'revise', chunks: [], reasoning: [], searching: false, traces: [], status: 'running', retry: params } }));
        scheduleRunFallback(runId);
        break;
      }
      default:
        break;
    }
  },

  async switchBranch(messageId: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.switchBranch(messageId);
    setState({ project });
  },

  /** 开启新话题（ux-review §4.5：自动命名 + 一键归档，无弹窗）。 */
  async newTopic(title?: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.newTopic(title);
    setState({ project });
  },

  /**
   * 编辑用户消息 → 新版本（§3.2）。DeepSeek 式：编辑提交 = 重新发送，
   * 提交后自动启动 chat run，让 AI 针对编辑后的消息重新回答。
   */
  async editMessage(messageId: string, content: string): Promise<void> {
    const api = getApi();
    if (state.activeRun?.status === 'running') throw new Error('RUN_IN_PROGRESS: 运行中不能编辑，请先等待完成或取消');
    const project = await api.conversation.edit(messageId, content);
    setState({ project });
    // 找到取代消息（新版本）作为 run 父节点；编辑后的续写从它开始
    const replacement = project.messages.find((m) => m.supersedesId === messageId);
    await this.startRun('chat', { parentMessageId: replacement?.id ?? project.activeMessageId, answerDetail: state.answerDetail });
  },

  // ------------------------------------------------------------ 会话（ux-review §4.5，ChatGPT 式）

  /** 切换会话：活动路径末端 = 该会话 tail；空会话 → 空视图。 */
  async switchSession(sessionId: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.switchSession(sessionId);
    setState({ project });
  },

  /** 显式归档：完全只读，移入「归档」隐藏层级；可取消归档。 */
  async archiveSession(sessionId: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.archiveSession(sessionId);
    setState({ project });
  },

  /** 取消归档：移回活跃层，恢复可继续追加。 */
  async unarchiveSession(sessionId: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.unarchiveSession(sessionId);
    setState({ project });
  },

  /** 删除会话（确认后永久删除）：该会话子树消息从日志剔除。 */
  async deleteSession(sessionId: string): Promise<void> {
    const api = getApi();
    const project = await api.conversation.deleteSession(sessionId);
    setState({ project });
  },

  /** 当前活动会话（含归档态判断，ux-review §4.5）。 */
  activeSession(): { session: import('../shared/types').ConversationSession; archived: boolean } | null {
    const project = state.project;
    if (!project || !project.activeSessionId) return null;
    const session = project.sessions.find((s) => s.id === project.activeSessionId);
    return session ? { session, archived: session.archived === true } : null;
  },

  /** 上下文视图（§7.3 只读）。 */
  async inspectContext(): Promise<ContextInspection> {
    const api = getApi();
    return api.context.inspect();
  },

  /** 手动重新压缩（§7.3：可指定重点；清除阻断标记）。 */
  async recompressContext(focus?: string): Promise<void> {
    const api = getApi();
    const project = await api.context.recompress(focus);
    setState({ project });
  },

  /** 收起整理结果卡片（Part 4：瞬态展示，收起即从界面移除，不影响 run 记录）。 */
  dismissOrganize(): void {
    setState({ lastOrganize: null });
  },

  // ------------------------------------------------------------ 版本历史（§5.5）

  async loadVersions(nodeId: string): Promise<NodeVersion[]> {
    const api = getApi();
    return api.nodeVersion.list(nodeId);
  },

  async readVersion(nodeId: string, snapshotId: string): Promise<string> {
    const api = getApi();
    return api.nodeVersion.read(nodeId, snapshotId);
  },

  // ------------------------------------------------------------ 回收站（§9.4）

  async restoreTrash(trashId: string): Promise<void> {
    const api = getApi();
    const project = await api.trash.restore(trashId);
    setState({ project });
  },

  async purgeTrash(trashId: string): Promise<void> {
    const api = getApi();
    const project = await api.trash.purge(trashId);
    setState({ project });
  },

  async cancelRun(): Promise<void> {
    const api = getApi();
    const run = state.activeRun;
    if (run) await api.run.cancel(run.runId);
  },

  /** 接收主进程流式事件。 */
  applyRunEvent(event: RunStreamEvent): void {
    const run = state.activeRun;
    if (!run || run.runId !== event.runId) return;
    switch (event.type) {
      case 'chunk':
        withState((s) => ({
          ...s,
          activeRun: {
            ...s.activeRun!,
            chunks: [...s.activeRun!.chunks, event.text],
            reasoning: event.reasoningContent
              ? [...s.activeRun!.reasoning, event.reasoningContent]
              : s.activeRun!.reasoning,
          },
        }));
        break;
      case 'trace':
        withState((s) => ({ ...s, activeRun: { ...s.activeRun!, traces: [...s.activeRun!.traces, event.trace] } }));
        break;
      case 'search':
        withState((s) => ({ ...s, activeRun: { ...s.activeRun!, searching: event.status === 'searching' } }));
        break;
      case 'done':
        // P0-1：取消且无回答 → 视为失败态（已产生文本保留为可复制失败块 + 重试）
        if (event.result.cancelled && !event.result.finalAnswer) {
          void this.finishRun(run.runId, '已取消', undefined, true);
        } else {
          void this.finishRun(run.runId, event.result.error ?? null, event.result.finalAnswer);
        }
        // Part 4：organize 沙箱化——成功后结果进瞬态卡片（不写对话日志）
        // P1 修复：失败/取消的整理同样进卡片（failed + 错误原因），
        // 卡片内可查看「部分修改详情」并回滚（快照已为失败 run 落盘）。
        if (run.kind === 'organize') {
          if (!event.result.error && !event.result.cancelled) {
            withState((s) => ({
              ...s,
              lastOrganize: { runId: event.result.runId, finalAnswer: event.result.finalAnswer ?? '' },
            }));
          } else if (event.result.runId) {
            withState((s) => ({
              ...s,
              lastOrganize: {
                runId: event.result.runId,
                finalAnswer: event.result.finalAnswer ?? '',
                failed: true,
                error: event.result.error ?? (event.result.cancelled ? '已取消（可能已产生部分写入）' : '未知错误'),
              },
            }));
          }
        }
        // 写作任务（沙箱隔离）：记录内部 runId，供正文模块「ⓘ 调用详情」入口（§4.7）
        if ((run.kind === 'detail_fill' || run.kind === 'revise') && event.result.runId) {
          withState((s) => ({ ...s, lastWritingRunId: event.result.runId }));
        }
        break;
      case 'error':
        void this.finishRun(run.runId, event.message, undefined, true);
        break;
      default:
        break;
    }
  },

  async finishRun(runId: string, error: string | null, finalAnswer?: string, isError = false): Promise<void> {
    const api = getApi();
    withState((s) => ({
      ...s,
      refreshingMessageId: null,
      activeRun: { ...s.activeRun!, status: isError ? 'error' : 'done', error: error ?? undefined, finalAnswer },
      lastRunId: runId,
    }));
    // 运行结束 → 刷新状态（ux-review §4.3：organize 完成不再强切右栏，保护未保存的编辑）
    try {
      const project = await api.state.get();
      withState((s) => ({ ...s, project }));
      // 完成通知（§4.1：窗口后台时任务完成发桌面通知，设置可关）
      if (!error && typeof Notification !== 'undefined' && document.hidden && project.settings.notifications) {
        try {
          const kindLabel = { chat: '回答', organize: '整理', detail_fill: '正文生成', revise: '改写' }[state.activeRun?.kind ?? 'chat'];
          new Notification('故事工坊', { body: `${kindLabel}已完成` });
        } catch {
          /* 通知不可用时静默 */
        }
      }
      // 无论 done / error 事件，只要运行带错误就明确提示（绝不静默）
      if (error) this.showToast(error, 'error');
    } catch (err) {
      this.showToast((err as Error).message, 'error');
    }
  },

  // ------------------------------------------------------------ 大纲/设定

  async createNode(parentId: string, type: 'volume' | 'chapter' | 'scene', title: string): Promise<void> {
    const api = getApi();
    const project = await api.outline.createNode(parentId, type, title);
    setState({ project });
  },

  async renameNode(nodeId: string, title: string): Promise<void> {
    const api = getApi();
    const project = await api.outline.renameNode(nodeId, title);
    setState({ project });
  },

  /** 移动节点（§3.1 拖拽重排）。 */
  async moveNode(nodeId: string, newParentId: string, index?: number): Promise<void> {
    const api = getApi();
    const project = await api.outline.moveNode(nodeId, newParentId, index);
    setState({ project });
  },

  async deleteNode(nodeId: string): Promise<void> {
    const api = getApi();
    const project = await api.outline.deleteNode(nodeId);
    setState({ project, selected: null, workspaceMode: null });
  },

  async writeDraft(nodeId: string, content: string): Promise<void> {
    const api = getApi();
    const project = await api.outline.writeDraft(nodeId, content);
    setState({ project });
  },

  async writeOfficial(nodeId: string, content: string): Promise<void> {
    const api = getApi();
    const project = await api.outline.writeOfficial(nodeId, content);
    setState({ project });
  },

  async commitNodes(nodeIds: string[], includePending: boolean): Promise<string | null> {
    const api = getApi();
    const result = await api.outline.commitNodes(nodeIds, includePending);
    const project = await api.state.get();
    setState({ project });
    return result.committed.length > 0 ? `已提交 ${result.committed.length} 个节点` : null;
  },

  async createAsset(type: string, title: string, content: string): Promise<void> {
    const api = getApi();
    const project = await api.asset.create(type, title, content);
    setState({ project });
  },

  async updateAsset(assetId: string, updates: { title?: string; type?: string; content?: string }): Promise<void> {
    const api = getApi();
    const project = await api.asset.update(assetId, updates);
    setState({ project });
  },

  async deleteAsset(assetId: string): Promise<void> {
    const api = getApi();
    const project = await api.asset.delete(assetId);
    setState({ project, selected: null, workspaceMode: null });
  },

  /** 暂存附件到待发送区（Part 3：不落盘、不进对话；发送时一并提交）。 */
  stageAttachment(name: string, content: string, source: 'uploaded' | 'workspace' | 'pasted'): void {
    setState({
      pendingAttachments: [
        ...state.pendingAttachments,
        { key: nextPendingKey(), name, content, source, size: new TextEncoder().encode(content).length },
      ],
    });
  },

  /** 从待发送区移除附件（未落盘，直接丢弃）。 */
  removePendingAttachment(key: string): void {
    setState({ pendingAttachments: state.pendingAttachments.filter((a) => a.key !== key) });
  },

  /** 读取附件完整正文（附件行展开用）。 */
  async readAttachmentContent(attachmentId: string): Promise<{ name: string; content: string } | null> {
    const api = getApi();
    return api.attachment.readContent(attachmentId);
  },

  /** 删除附件（确认后永久删除）：移除索引与正文文件，历史引用行自动隐藏。 */
  async deleteAttachment(attachmentId: string): Promise<void> {
    const api = getApi();
    const project = await api.attachment.delete(attachmentId);
    setState({ project });
  },

  /** 文件选择对话框 → 预读并暂存到待发送区（§3.1 'uploaded'）；返回暂存数量。 */
  async pickFiles(): Promise<number> {
    const api = getApi();
    const files = await api.attachment.pickFiles();
    if (!files || files.length === 0) return 0;
    for (const f of files) this.stageAttachment(f.name, f.content, 'uploaded');
    return files.length;
  },

  /** 扫描项目文件夹顶层散落的文本文件（「项目文件」分组，§3.1）。 */
  async scanWorkspaceFiles(): Promise<Array<{ name: string; size: number }>> {
    const api = getApi();
    return api.attachment.scanWorkspace();
  },

  /** 只读项目顶层文件并暂存到待发送区（Part 3；原文件不移动不删除）。 */
  async stageWorkspaceFile(name: string): Promise<void> {
    const api = getApi();
    const read = await api.attachment.readWorkspace(name);
    if (!read) return;
    this.stageAttachment(read.name, read.content, 'workspace');
  },

  // ------------------------------------------------------------ 可见视图/正文（§6）

  /** 读取节点内容（编辑器初始化与对照浏览）。 */
  async readNodeContent(nodeId: string): Promise<NodeContent> {
    const api = getApi();
    return api.outline.readContent(nodeId);
  },

  /** 读取场景可见视图；不存在返回 null。 */
  async loadVisibleView(sceneId: string): Promise<VisibleView | null> {
    const api = getApi();
    return api.visibleView.read(sceneId);
  },

  /** 生成（或重新生成）可见视图（§6.3）。 */
  async generateVisibleView(sceneId: string): Promise<void> {
    const api = getApi();
    const project = await api.visibleView.generate(sceneId);
    setState({ project });
  },

  /** 保存手改（§6.4）。 */
  async saveVisibleView(sceneId: string, content: string): Promise<void> {
    const api = getApi();
    const project = await api.visibleView.save(sceneId, content);
    setState({ project });
  },

  /** 场景输出列表（含失效标记）。 */
  async loadOutputs(sceneId: string): Promise<OutputInfo[]> {
    const api = getApi();
    return api.output.list(sceneId);
  },

  /** 读取正文内容。 */
  async readOutput(sceneId: string, format: string): Promise<string> {
    const api = getApi();
    return api.output.read(sceneId, format);
  },

  /** 可用正文格式（模板清单，§6.6）。 */
  async loadFormats(): Promise<string[]> {
    const api = getApi();
    return api.output.formats();
  },

  /** 手工保存正文（写入前快照，进版本历史；§6.5 修订）。 */
  async saveOutput(sceneId: string, format: string, content: string): Promise<void> {
    const api = getApi();
    const project = await api.output.save(sceneId, format, content);
    setState({ project });
  },

  /** 正文版本历史（生成/改写/手工保存各成一版）。 */
  async loadOutputVersions(sceneId: string, format: string): Promise<OutputVersion[]> {
    const api = getApi();
    return api.output.versions(sceneId, format);
  },

  /** 读取某版本正文内容。 */
  async readOutputVersion(sceneId: string, format: string, snapshotId: string): Promise<string> {
    const api = getApi();
    return api.output.readVersion(sceneId, format, snapshotId);
  },

  /** 整书导出（保存对话框选路径）；缺失场景不阻断。 */
  async exportBook(format: string, options: { includeTitles: boolean }): Promise<ExportBookResult> {
    const api = getApi();
    return api.output.export(format, options);
  },

  /** 全局搜索（§6.9）。 */
  async globalSearch(query: string): Promise<GlobalSearchResult[]> {
    const api = getApi();
    return api.search.global(query);
  },

  // ------------------------------------------------------------ 未保存保护（ux-review §6.8）

  /** 组件自定义切换前的统一守卫（如正文格式切换）。 */
  async guardLeave(match: (key: string) => boolean): Promise<boolean> {
    return guardBeforeLeave(match);
  },

  /** 是否有任意编辑器未保存（关窗 beforeunload 用）。 */
  hasDirtyEditors(): boolean {
    return hasAnyDirty();
  },

  // ------------------------------------------------------------ 摘要/回滚

  async acceptRun(runId: string): Promise<void> {
    const api = getApi();
    const project = await api.run.accept(runId);
    setState({ project });
  },

  async rollbackRun(runId: string): Promise<void> {
    const api = getApi();
    const project = await api.run.rollback(runId);
    setState({ project });
  },

  /** 变更摘要的文件级 diff（§5.4）。 */
  async loadRunDiff(runId: string): Promise<FileDiff[]> {
    const api = getApi();
    return api.run.diff(runId);
  },

  /** 运行摘要列表（organize 总结消息内展开变更详情用，§4.2）。 */
  async listRuns(): Promise<RunSummaryEntry[]> {
    const api = getApi();
    return api.run.list();
  },

  /** 每消息级「调用详情」（ux-review §4.7）。 */
  async inspectRun(runId: string): Promise<import('../shared/types').RunRecord | null> {
    const api = getApi();
    return api.run.inspect(runId);
  },

  /** 在对话流中定位消息（§4.7：想看原文 → 点消息跳回对话流定位）。 */
  async jumpToMessage(messageId: string): Promise<void> {
    const project = state.project;
    if (!project) return;
    if (!project.messages.some((m) => m.id === messageId)) {
      this.showToast('该消息不在当前对话日志中', 'info');
      return;
    }
    await this.switchBranch(messageId);
  },

  async saveApiKey(key: string): Promise<void> {
    const api = getApi();
    const project = await api.settings.setKey(key);
    setState({ project });
  },

  /** 更新全局设置（模型 / 思考模式 / 思考强度 / 主题，DeepSeek V4）。 */
  async updateSettings(partial: Partial<AppSettings>): Promise<void> {
    const api = getApi();
    const project = await api.settings.update(partial);
    // 主题即时应用（项目屏无 project 也能换主题：settings 是全局的）
    if (partial.theme) applyTheme(partial.theme);
    // 无项目打开时返回 null：只同步设置，不破坏状态
    setState(project ? { project } : {});
  },

  // ------------------------------------------------------------ 派生

  /** 活动路径消息（展示用；缓存于 state.activePath）。 */
  activePath(): ChatMessage[] {
    return state.activePath;
  },

  /** 光标后未整理消息数（缓存于 state.unorganizedCount，§5.3）。 */
  unorganizedCount(): number {
    return state.unorganizedCount;
  },

  /** 节点子树 id 展开（含自身）。 */
  subtreeIds(nodeId: string): string[] {
    const project = state.project;
    if (!project) return [nodeId];
    const byParent = new Map<string | null, Array<{ id: string; parentId: string | null }>>();
    for (const n of project.nodes) {
      const list = byParent.get(n.parentId) ?? [];
      list.push(n);
      byParent.set(n.parentId, list);
    }
    const out: string[] = [];
    const walk = (id: string): void => {
      out.push(id);
      for (const child of byParent.get(id) ?? []) walk(child.id);
    };
    walk(nodeId);
    return out;
  },
};

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selector(store.getState()),
  );
}

/**
 * ipc-types.ts — 主进程 ↔ 渲染进程的 IPC 契约（M4）。
 *
 * 渲染层只通过这些类型与主进程通信；数据形状来自 storage 仓库与
 * agent-runtime，这里只做组装与瘦身。
 */
import type {
  Asset,
  Attachment,
  ChangeItem,
  ChatMessage,
  ConversationSession,
  NodeType,
  OutlineTree,
  RunRecord,
  RunSummary,
  TaskKind,
  ToolCallTrace,
  VisibleView,
} from './types';
import type { AppSettings } from './llm-types';

/** 节点扁平摘要（渲染层大纲树用） */
export interface NodeSummary {
  id: string;
  type: NodeType;
  title: string;
  parentId: string | null;
  depth: number;
  hidden?: boolean;
  aiCreated?: boolean;
  hasDraft: boolean;
  hasOfficial: boolean;
  draftHash?: string;
  officialHash?: string;
  updatedAt?: string;
  /** 可见视图状态（§6.3；场景节点可能携带） */
  visibleView?: {
    exists: boolean;
    sourceHash?: string;
    userEdited?: boolean;
    needsRegeneration?: boolean;
    generatedAt?: string;
  };
  /** 已生成的正文媒介列表（§3.5） */
  outputFormats: string[];
}

/** 正文输出条目（§3.5：可见视图变更后 stale=true） */
export interface OutputInfo {
  format: string;
  stale: boolean;
  generatedAt: string;
}

/** 节点内容读取结果（右栏编辑器初始化与可见视图对照用） */
export interface NodeContent {
  id: string;
  title: string;
  type: NodeType;
  official: string | null;
  draft: string | null;
}

/** 节点版本历史的一页（§5.5：提交/运行快照中该节点正式版文件） */
export interface NodeVersion {
  snapshotId: string;
  createdAt: string;
  hash: string;
}

/** 回收站条目（§9.4：节点删除进回收站，永久删除需单独确认） */
export interface TrashEntry {
  id: string;
  nodeId: string;
  title: string;
  type: NodeType;
  parentId: string | null;
  /** 被移入回收站的子树全部节点 id（含自身） */
  subtreeIds: string[];
  movedAt: string;
}

/** 上下文视图（§7.3 只读透明度工具）：展示一次模型调用实际收到什么 */
export interface ContextInspection {
  messageCount: number;
  budgetTokens: number;
  estimatedTokens: number;
  /** 本次组装是否使用压缩摘要 */
  compressed: boolean;
  /** 保留原文的消息条数（最近几轮，§7.3） */
  keptRawCount: number;
  /** 摘要锚点 = 被压缩前缀的最后一条消息 id（分支各自维护摘要） */
  summaryAnchor?: string;
  /** 摘要文本（存在时） */
  summary?: string;
  /** 压缩阻断标记（§7.4：连续失败后暂停自动压缩） */
  blocked: boolean;
}

/** 变更摘要的文件级 diff 条目（§5.4：快照=写前，当前=写后；null = 不存在） */
export interface FileDiff {
  path: string;
  before: string | null;
  after: string | null;
}

/** 项目完整只读状态（渲染层加载/刷新用） */
export interface ProjectState {
  dir: string;
  name: string;
  outline: OutlineTree | null;
  nodes: NodeSummary[];
  assets: Asset[];
  attachments: Attachment[];
  messages: ChatMessage[];
  sessions: ConversationSession[];
  /** 当前活动会话（ChatGPT 式对话，ux-review §4.5） */
  activeSessionId?: string;
  activeMessageId?: string;
  organizeCursor?: string;
  runSummaries: RunSummaryEntry[];
  hasApiKey: boolean;
  maskedApiKey?: string;
  /** 回收站条目（§9.4；空数组 = 无） */
  trash: TrashEntry[];
  /** 全局设置（模型 / 思考模式 / 思考强度） */
  settings: AppSettings;
}

export interface ProjectInfo {
  dir: string;
  name: string;
  createdAt: string;
}

/** 变更摘要列表条目（RunSummary + 展示用时间戳） */
export type RunSummaryEntry = RunSummary & { createdAt: string };

export type OrganizeScope =
  | { type: 'unorganized' }
  | { type: 'all' };

/** run:start 请求 */
export interface RunStartRequest {
  kind: 'chat' | 'organize';
  /** chat：用户消息 id（作为上下文末尾与 parentMessageId） */
  parentMessageId?: string;
  /** organize 范围 */
  scope?: OrganizeScope;
  /** 附带说明（追加到范围描述，可选） */
  note?: string;
}

/** run:start 响应：runId 用于订阅流式事件 */
export interface RunStartResponse {
  runId: string;
}

/** 主进程推送的流式事件 */
export type RunStreamEvent =
  | { type: 'start'; runId: string }
  | { type: 'chunk'; runId: string; text: string; reasoningContent?: string }
  | { type: 'trace'; runId: string; trace: ToolCallTrace }
  | { type: 'search'; runId: string; status: 'searching' | 'completed' }
  | { type: 'done'; runId: string; result: RunResultPayload }
  | { type: 'error'; runId: string; message: string };

export interface RunResultPayload {
  runId: string;
  taskKind: TaskKind;
  finalAnswer: string;
  turns: number;
  toolCallCount: number;
  snapshotId?: string;
  changes: ChangeItem[];
  cancelled: boolean;
  error?: string;
}

/** outline:commitNodes 结果 */
export interface CommitResult {
  runId: string;
  committed: string[];
  skippedPending: string[];
  /** 影响汇总（提交前展示用）：全部目标节点 id（含子树展开） */
  affected: string[];
}

/** 渲染层窗口暴露的 API（preload 注入 window.electronAPI） */
export interface RendererApi {
  app: {
    getVersion(): Promise<string>;
  };
  project: {
    list(): Promise<ProjectInfo[]>;
    /** 在默认项目目录下创建（主进程自动生成目录名） */
    create(name: string): Promise<ProjectState>;
    open(dir: string): Promise<ProjectState>;
    pickFolder(): Promise<string | null>;
    /** 删除项目（确认后移到系统回收站，可恢复）；打开中的项目会自动关闭 */
    delete(dir: string): Promise<void>;
  };
  state: {
    get(): Promise<ProjectState>;
  };
  outline: {
    createNode(parentId: string, type: NodeType, title: string): Promise<ProjectState>;
    renameNode(nodeId: string, title: string): Promise<ProjectState>;
    deleteNode(nodeId: string): Promise<ProjectState>;
    /** 移动节点到新父节点（§3.1；index 缺省 = 追加末尾） */
    moveNode(nodeId: string, newParentId: string, index?: number): Promise<ProjectState>;
    writeDraft(nodeId: string, content: string): Promise<ProjectState>;
    writeOfficial(nodeId: string, content: string): Promise<ProjectState>;
    commitNodes(nodeIds: string[], includePending?: boolean): Promise<CommitResult>;
    /** 读取节点内容（正式版/草稿；编辑器初始化与对照浏览） */
    readContent(nodeId: string): Promise<NodeContent>;
  };
  asset: {
    create(type: string, title: string, content: string): Promise<ProjectState>;
    update(assetId: string, updates: { title?: string; type?: string; content?: string }): Promise<ProjectState>;
    delete(assetId: string): Promise<ProjectState>;
  };
  attachment: {
    /** 文件选择对话框 → 预读文件内容（Part 3：发送时才落盘）；取消/无成功文件返回 null */
    pickFiles(): Promise<Array<{ name: string; content: string }> | null>;
    /** 扫描项目文件夹顶层散落的文本文件（「项目文件」分组，§3.1） */
    scanWorkspace(): Promise<Array<{ name: string; size: number }>>;
    /** 只读项目顶层文本文件（待发送附件预读）；不存在返回 null */
    readWorkspace(name: string): Promise<{ name: string; content: string } | null>;
    /** 读取附件完整正文（附件行展开用）；不存在返回 null */
    readContent(attachmentId: string): Promise<{ name: string; content: string } | null>;
    /** 删除附件（确认后永久删除）：移除索引条目与正文文件；历史消息引用该附件的行为自动隐藏 */
    delete(attachmentId: string): Promise<ProjectState>;
  };
  visibleView: {
    /** 读取场景可见视图；不存在返回 null */
    read(sceneId: string): Promise<VisibleView | null>;
    /** 生成（或重新生成）可见视图（§6.3；重新生成会覆盖手改，UI 先确认） */
    generate(sceneId: string): Promise<ProjectState>;
    /** 保存手改（置位 userEdited，§6.4） */
    save(sceneId: string, content: string): Promise<ProjectState>;
  };
  output: {
    /** 可用格式（模板清单） */
    formats(): Promise<string[]>;
    /** 场景输出列表（含失效标记） */
    list(sceneId: string): Promise<OutputInfo[]>;
    /** 读取正文内容 */
    read(sceneId: string, format: string): Promise<string>;
    /** 接受就地改写（§5.3：替换 = 新文本替换原选区，写入前快照，单级撤销） */
    applyRevise(sceneId: string, format: string, start: number, end: number, replacement: string): Promise<ProjectState>;
    /** 撤销上次改写（§5.3：单级；多级由版本历史兜底） */
    undoRevise(sceneId: string, format: string): Promise<ProjectState>;
  };
  conversation: {
    send(content: string): Promise<ProjectState>;
    /** 一次提交「文本 + 待发送附件」（Part 3：附件发送时才落盘进对话） */
    sendWithAttachments(content: string, attachments: Array<{ name: string; content: string; source?: 'pasted' | 'uploaded' | 'workspace' }>): Promise<ProjectState>;
    /** 开启新话题（ux-review §4.5：新建空会话并设为活动，不归档当前话题） */
    newTopic(title?: string): Promise<ProjectState>;
    /** 切换会话（ChatGPT 式：活动路径末端 = 该会话 tail；空会话 → 空视图） */
    switchSession(sessionId: string): Promise<ProjectState>;
    /** 显式归档：完全只读，移入「归档」层级；可取消归档 */
    archiveSession(sessionId: string): Promise<ProjectState>;
    /** 取消归档：移回活跃层，恢复可继续追加 */
    unarchiveSession(sessionId: string): Promise<ProjectState>;
    /** 删除会话（确认后永久删除）：该会话子树消息从日志剔除 */
    deleteSession(sessionId: string): Promise<ProjectState>;
    switchBranch(messageId: string): Promise<ProjectState>;
    /** 编辑用户消息 → 分支（§3.2：不原地覆盖，旧尾部保留为分支） */
    edit(messageId: string, content: string): Promise<ProjectState>;
  };
  context: {
    /** 上下文视图（§7.3 只读）：本次组装实际收到什么 */
    inspect(): Promise<ContextInspection>;
    /** 手动重新压缩（可指定重点；只影响摘要详略，§7.3）。清除压缩阻断标记。 */
    recompress(focus?: string): Promise<ProjectState>;
  };
  nodeVersion: {
    /** 节点版本历史（§5.5：正式版内容的各版快照） */
    list(nodeId: string): Promise<NodeVersion[]>;
    /** 读取某版本正式版内容 */
    read(nodeId: string, snapshotId: string): Promise<string>;
  };
  trash: {
    restore(trashId: string): Promise<ProjectState>;
    /** 永久删除（§9.4：需单独确认） */
    purge(trashId: string): Promise<ProjectState>;
  };
  run: {
    start(req: RunStartRequest): Promise<RunStartResponse>;
    cancel(runId: string): Promise<void>;
    onEvent(listener: (event: RunStreamEvent) => void): () => void;
    /** 刷新最后一条 AI 消息（重新生成，旧回复保留为兄弟分支） */
    refresh(messageId: string): Promise<RunStartResponse>;
    /** 正文生成（detail_fill，§6.5）：可见视图 → 正文 → outputs 落盘 */
    detailFill(sceneId: string, format: string, feedback?: string): Promise<RunStartResponse>;
    /** 就地改写（revise，§5.3）：模型返回选中区间的完整替换文本 */
    revise(sceneId: string, format: string, start: number, end: number, instruction: string): Promise<RunStartResponse>;
    /** 变更摘要的文件级 diff（§5.4） */
    diff(runId: string): Promise<FileDiff[]>;
    /** 运行摘要列表（含 createdAt；organize 总结消息内展开用，§4.2） */
    list(): Promise<RunSummaryEntry[]>;
    /** 每消息级「调用详情」（ux-review §4.7）；不存在返回 null */
    inspect(runId: string): Promise<RunRecord | null>;
    accept(runId: string): Promise<ProjectState>;
    rollback(runId: string): Promise<ProjectState>;
  };
  settings: {
    setKey(key: string): Promise<ProjectState>;
    /** 更新全局设置（模型 / 思考模式 / 思考强度，DeepSeek V4） */
    update(partial: Partial<AppSettings>): Promise<ProjectState>;
  };
}

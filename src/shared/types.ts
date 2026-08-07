/**
 * Evidence reference — every tool result must cite its sources.
 * Single source of truth for evidence/citation types (re-exported by
 * agent-runtime/tool-types.ts).
 */
export interface EvidenceRef {
  /** Source identifier */
  sourceId: string;
  /** Type of source (e.g. 'node', 'conversation', 'attachment', 'snapshot') */
  sourceType: string;
  /** Optional file path to the source */
  path?: string;
  /** Optional node ID if the evidence comes from a node */
  nodeId?: string;
  /** Optional version ID if the evidence comes from a specific version */
  versionId?: string;
  /** Content hash for integrity verification */
  hash: string;
  /** Optional excerpt or content reference */
  excerpt?: string;
}

/** EvidenceRef with an index for citation numbering */
export type IndexedEvidenceRef = EvidenceRef & { citationIndex: number };

// ---------------------------------------------------------------------------
// 领域模型（design doc §3、§4.2）—— 存储层与渲染层共享的核心类型
// ---------------------------------------------------------------------------

/** 大纲树节点类型：总纲 / 卷 / 章 / 场景 */
export type NodeType = 'overview' | 'volume' | 'chapter' | 'scene';

export interface OutlineNode {
  id: string;
  type: NodeType;
  title: string;
  children: OutlineNode[]; // 顺序即大纲顺序
  /** 自动插入的隐藏中间层级（如「卷 > 场景」时自动插入的章） */
  hidden?: boolean;
  /** AI 创建、尚未审阅的标记（审阅后清除） */
  aiCreated?: boolean;
}

/** outline.json 的顶层结构 */
export interface OutlineTree {
  version: 1;
  root: OutlineNode;
}

/** 一次工具调用的追踪记录（流式/取消/工具调用记录） */
export interface ToolCallTrace {
  toolName: string;
  args: unknown;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  /** 单亲（消息树，不是图）；缺省 = 根级消息 */
  parentId?: string;
  /**
   * 兄弟分支（读取时派生：parentId === id 的消息 id 列表）。
   * 日志不可变（§7.1），因此不持久化，由仓库按 parentId 推导。
   */
  childrenIds?: string[];
  /**
   * 本消息取代了哪条消息（刷新/编辑产生）。
   * 不可变指针，写入时设置；被取代方的 supersededBy 由仓库派生。
   */
  supersedesId?: string;
  /** 被刷新/编辑取代（读取时派生：supersedesId === id 的消息 id） */
  supersededBy?: string;
  /**
   * 版本组根 id（读取时派生，DeepSeek 式 ◀ i/N ▶ 导航）：沿 supersedesId
   * 链回溯到根；普通消息（无取代关系）= 自身 id。
   */
  versionGroupId?: string;
  /** 版本序号（读取时派生：版本组内按日志顺序 1 起编号） */
  versionIndex?: number;
  /** 版本总数（读取时派生：同 versionGroupId 的消息数） */
  versionCount?: number;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
  /** 关联的 agent run */
  runId?: string;
  /** 流式/取消/工具调用记录 */
  toolTrace?: ToolCallTrace[];
  /**
   * 思维链全文（ux-review §4.1：折叠为「已深度思考（X 秒）」可展开；
   * 只在 AI 消息上持久化，不展示原始文本尾部）。
   */
  reasoning?: string;
  /** 思考耗时（秒，推理时计时；reasoning 非空时存在） */
  thinkingSeconds?: number;
  /** 引用，不存正文 */
  refs?: { attachmentIds?: string[]; nodeIds?: string[] };
}

/**
 * 会话（ChatGPT 式对话，ux-review §4.5）：
 * - 开启新话题 = 新建会话并设为活动，旧话题保持活跃（可切回继续追加）；
 * - 归档 = 显式操作：archived=true 后完全只读，移入「归档」隐藏层级，可取消归档；
 * - 删除会话 = 显式操作：该会话子树消息从日志永久剔除。
 */
export interface ConversationSession {
  id: string;
  title: string;
  /**
   * 标题是否为占位/自动生成（createSession 的「话题 N」或首条消息启发式）：
   * true 时在首个对话 run 完成后由 AI 自动命名（ChatGPT/DeepSeek 式），
   * 成功后置 false；失败保留占位、下次 run 重试。
   */
  titleAuto?: boolean;
  /** 会话首条消息 id（懒记录：首条消息落盘时写入） */
  rootMessageId?: string;
  /**
   * 会话当前活动路径末端（继续聊 = 在此追加；随追加持续更新，
   * 不是归档时快照）。无消息的空会话 = undefined。
   */
  tailMessageId?: string;
  /** 显式归档标记：完全只读（不可追加/编辑/重新生成），可取消归档 */
  archived?: boolean;
  /** 会话创建（归档）时间 */
  archivedAt: string;
}

export interface Attachment {
  id: string;
  name: string;
  source: 'pasted' | 'uploaded' | 'workspace';
  /** 字节数（附件行展示） */
  size: number;
  hash: string;
  mtime: string;
  createdAt: string;
  /**
   * 整理任务结构化此附件时记录的 hash（§4.3）：附件被外部修改或重传后，
   * lastStructured.hash ≠ 当前 hash → 提示「已更新」。
   */
  lastStructured?: { runId: string; hash: string; at: string };
  /** 派生标记（不持久化）：结构化后内容已变化，整理结果可能过期（§4.3）。 */
  needsRestructure?: boolean;
}

/**
 * 设定：type 是自由字符串 + 建议预设，不强制 schema
 * character | worldbuilding | timeline | location | prop | foreshadow | misc
 */
export interface Asset {
  id: string;
  type: string;
  title: string;
  /** markdown 自由格式；模板是引导，不是约束 */
  content: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

/** 设定类型的 UI 中文文案（内部存储保持英文枚举，仅展示层汉化）。 */
export const ASSET_TYPE_LABELS: Record<string, string> = {
  character: '角色',
  worldbuilding: '世界观',
  timeline: '编年史',
  location: '地点',
  prop: '道具',
  foreshadow: '伏笔',
  misc: '杂项',
};

/** 设定类型 → 中文标签；未知类型（自定义）原样返回。 */
export function assetTypeLabel(type: string): string {
  return ASSET_TYPE_LABELS[type] ?? type;
}

export interface ConversationMeta {
  /** 整理光标：之后的消息 = 未整理内容（跨会话全局，§3.2） */
  lastOrganizedMessageId?: string;
  /** 活动路径末端（消息树） */
  activeMessageId?: string;
  /** 当前活动会话（ChatGPT 式对话，ux-review §4.5） */
  activeSessionId?: string;
  /** 已建会话列表（开启新话题产生；活跃与归档共存） */
  sessions?: ConversationSession[];
  /**
   * 压缩阻断标记（§7.4）：压缩任务连续失败后置位，暂停自动压缩
   * （原始对话没有丢失）；手动重新压缩时清除。
   */
  compressionBlocked?: boolean;
}

export interface VisibleView {
  sceneId: string;
  content: string;
  /** 生成时所依据的细纲内容 hash */
  sourceHash: string;
  /** 用户手改后为 true，阻止静默覆盖 */
  userEdited: boolean;
  /**
   * 细纲变更且视图被手改时置位（未手改的视图在细纲变更后自动重新生成，
   * §6.3）。手改过的视图受保护，不静默覆盖（§6.4）。
   */
  needsRegeneration: boolean;
  generatedAt: string;
}

/**
 * 暂不明示标记：披露意图的结构化表达，写在场景细纲文本中（§6.1）。
 * 语法：{{暂不明示：内容}} —— 生成可见视图时整段机械移除，不做润色。
 * 规则：不支持嵌套；插入者 = 作者（直接书写）或整理 Agent（转译意图 / AI 建议，§6.2）。
 */
export const DISCLOSURE_MARKER_OPEN = '{{暂不明示：';
export const DISCLOSURE_MARKER_CLOSE = '}}';

export type TaskKind = 'chat' | 'organize' | 'detail_fill' | 'revise';

export type ChangeItem =
  | { action: 'draft_updated'; nodeId: string; beforeHash?: string; afterHash?: string }
  | { action: 'node_created'; nodeId: string; parentId: string; title: string }
  | { action: 'node_deleted'; nodeId: string }
  | { action: 'node_renamed'; nodeId: string; from: string; to: string }
  | { action: 'asset_created'; assetId: string; type: string; title: string }
  | { action: 'asset_updated'; assetId: string; beforeHash?: string; afterHash?: string };

export interface RunSummary {
  runId: string;
  taskKind: TaskKind;
  /** 写入前快照目录 */
  snapshotId: string;
  /** 本次依据的人话描述 */
  scope: string;
  /** 逐个变更 */
  changes: ChangeItem[];
}

/**
 * 每消息级「调用详情」记录（ux-review §4.7）：
 * conversation/runs/<runId>.json —— 一次 AI 调用应用给模型发送了什么、模型返回了什么。
 * 发送区引用式（角色 · 来源[原文/摘要] · 字数），不堆原文；返回区工具序列 + 最终回答标注。
 */
export interface RunRecord {
  runId: string;
  taskKind: TaskKind | 'compress';
  scope: string;
  status: 'done' | 'error' | 'cancelled';
  /** 耗时（毫秒） */
  durationMs: number;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  sent: {
    systemPrompt: string;
    /** 组装后的消息清单（引用式：角色 · 来源[原文/摘要] · 字数） */
    messages: Array<{
      /** 对话日志中的消息 id（summary 消息无日志 id） */
      messageId?: string;
      role: 'user' | 'ai' | 'system';
      /** 原文（raw）或压缩摘要（summary） */
      source: 'raw' | 'summary';
      chars: number;
    }>;
    /** 走了压缩时：摘要锚点 + 摘要全文 + 保留原文区间 */
    compression?: { anchor: string; summary: string; keptFrom: number; keptRawCount: number };
    whitelist: string[];
  };
  returned: {
    /** 工具调用序列（名称 · 参数 · 状态 · 错误 · 耗时） */
    toolCalls: Array<{ name: string; args: unknown; status: string; error?: string; durationMs: number }>;
    /** 最终回答标注（见本条消息 = 对话流中的 AI 消息） */
    finalAnswer: string;
    error?: string;
  };
  createdAt: string;
}

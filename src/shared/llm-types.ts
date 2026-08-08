export type LLMProvider = 'deepseek';

/** 思考模式（DeepSeek V4：默认开启，effort 默认 high）。 */
export type ThinkingMode = 'enabled' | 'disabled';

/** 思考强度：low / high / max（v4-flash 映射 low|high|max；v4-pro 映射 high|max）。 */
export type ReasoningEffort = 'low' | 'high' | 'max';

/** 模型选项（DeepSeek V4：flash = 快，pro = 强）。 */
export type DeepSeekModelId = 'deepseek-v4-flash' | 'deepseek-v4-pro';

/** 界面主题（主题系统：仅覆盖设计令牌，不动组件结构）。 */
export type ThemeId = 'system' | 'parchment' | 'nebula' | 'sakura' | 'emerald';

/** 全局设置（明文存于 ~/.story-workshop/settings.json，非敏感）。 */
export interface AppSettings {
  model: DeepSeekModelId;
  /** 思考模式开关（默认开启） */
  thinking: boolean;
  /** 思考强度（思考关闭时忽略） */
  reasoningEffort: ReasoningEffort;
  /** 完成通知（ux-review §4.1：窗口后台时任务完成发桌面通知，可关） */
  notifications: boolean;
  /** 界面主题（缺省跟随系统；设置存 settings.json，首帧镜像存 localStorage） */
  theme: ThemeId;
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** 思维链（DeepSeek V4 思考模式；带 tools 的请求必须回传） */
  reasoning_content?: string;
  tool_calls?: Array<
    | {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }
    /** 联网搜索调用（Responses API 原生 web_search；回传时原样转成 web_search_call item） */
    | { id: string; type: 'web_search' }
  >;
  tool_call_id?: string;
}

export interface LLMRequest {
  model?: string;
  messages: LLMMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: Array<
    | {
        type: 'function';
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }
    /** 原生联网搜索工具（服务端执行，仅 Responses API 支持） */
    | { type: 'web_search' }
  >;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } } | { type: 'web_search' };
  /** 思考模式开关（DeepSeek V4；缺省 = 默认开启） */
  thinking?: { type: ThinkingMode };
  /** 思考强度（DeepSeek V4；思考关闭时忽略） */
  reasoningEffort?: ReasoningEffort;
}

/** Responses API 的 web_search_call 输出 item（回传时需原样保留，服务端自动恢复搜索结果）。 */
export interface WebSearchCallItem {
  id: string;
  status?: string;
  action: { type: string; queries?: string[] };
}

export interface LLMResponse {
  id: string;
  content: string;
  /** 思维链（DeepSeek V4 思考模式；非流式响应） */
  reasoningContent?: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** 服务端联网搜索调用（Responses API；回传需原样注入） */
  webSearchCalls?: WebSearchCallItem[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMStreamChunk {
  content: string;
  finishReason: string | null;
  toolCalls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
  /** 思维链增量（DeepSeek V4 思考模式，与 content 同级；§思考模式） */
  reasoningContent?: string;
  /** 服务端联网搜索状态（Responses API 原生 web_search） */
  searchStatus?: 'searching' | 'completed';
  /** 流结束时未作为函数工具返回的 web_search_call 原始 item（供虚拟化回传） */
  webSearchCalls?: WebSearchCallItem[];
  /** 流结束时的 usage（stream_options.include_usage，可选） */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type LLMErrorCode =
  | 'auth_error'
  | 'rate_limit'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export interface LLMError {
  code: LLMErrorCode;
  message: string;
  statusCode?: number;
}

export interface ApiKeyEntry {
  provider: LLMProvider;
  key: string;
  maskedKey: string;
  lastUpdated: string;
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export interface ProjectInfo {
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek V4 模型（2026-08 起 deepseek-chat / deepseek-reasoner 已更名）。 */
export const DEEPSEEK_DEFAULT_MODEL: DeepSeekModelId = 'deepseek-v4-flash';

export const DEEPSEEK_MODELS: DeepSeekModelId[] = ['deepseek-v4-flash', 'deepseek-v4-pro'];

export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'high', 'max'];

export const THEME_IDS: ThemeId[] = ['system', 'parchment', 'nebula', 'sakura', 'emerald'];

export function defaultSettings(): AppSettings {
  return {
    model: DEEPSEEK_DEFAULT_MODEL,
    thinking: true,
    reasoningEffort: 'high',
    notifications: true,
    theme: 'system',
  };
}

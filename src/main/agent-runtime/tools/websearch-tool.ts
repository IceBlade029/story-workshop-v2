/**
 * websearch-tool.ts — 联网搜索工具（服务端执行，Responses API 原生 web_search）。
 *
 * 执行体是占位：真正的搜索由 DeepSeek 服务端自动完成并把结果注入上下文，
 * run-loop 的「占位执行 + tool 结果回传」闭环由 transport 层消化
 * （web_search_call 原样回传，服务端自动恢复搜索结果）。本地不发起任何请求。
 *
 * 仅 deepseek-v4-flash 支持（Responses API 目前不支持 pro；pro 时由
 * transport 从工具列表过滤该工具，白名单保留但模型不可见）。
 */
import type { ToolSpec } from '../tool-types';

export function makeWebSearchTool(): ToolSpec {
  return {
    name: 'web_search',
    description:
      '联网搜索实时信息（最新新闻、事实核查、具体数据等需要时效性或上下文之外的事实）。' +
      '由服务端自动执行：搜索动作及其结果由服务端注入上下文，无需本地执行；调用后等待服务端恢复搜索结果再继续作答。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索内容（简洁关键词或问题）' },
      },
      required: ['query'],
    } as never,
    outputSchema: {} as never,
    async execute(_ctx, _args: { query?: string }) {
      // 占位：搜索由服务端执行并注入上下文；这里只让 run-loop 闭环
      return { ok: true, data: { status: 'server_executed' }, evidence: [] };
    },
  };
}

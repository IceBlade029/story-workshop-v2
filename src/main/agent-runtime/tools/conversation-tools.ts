/**
 * conversation-tools.ts — 对话检索工具（§3.2、§8.2 chat 白名单）。
 *
 * search_conversation：Agent 可搜索对话历史（含已归档会话——归档只对用户
 * 只读，AI 随时可查，ux-review §4.5），供回看旧话题、找回先前讨论过的内容。
 * 只读。
 */
import type { ToolSpec } from '../tool-types';
import { ConversationRepository } from '../../storage/conversation-repository';
import { sha256 } from '../../storage/hash';
import { ok, matchesQuery } from './tool-utils';

export function makeConversationReadTools(projectDir: () => string): ToolSpec[] {
  const conv = () => new ConversationRepository(projectDir());

  return [
    {
      name: 'search_conversation',
      description: '在全局对话历史（含已归档会话）中搜索消息内容，返回匹配消息（id、角色、时间、所属会话、摘要）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
          sessionId: { type: 'string', description: '限定某个会话（可选）' },
          limit: { type: 'number', description: '最多返回条数（默认 10）' },
        },
        required: ['query'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { query: string; sessionId?: string; limit?: number }) {
        const repo = conv();
        const messages = repo.readMessagesWithTree();
        const limit = args.limit ?? 10;
        const sessions = repo.listSessions();
        // 会话归属：消息沿 parent 回溯到根，与「会话根」匹配（归档会话照常归属）
        const rootsOf = new Map<string, string>();
        for (const s of sessions) {
          const root = repo.sessionRootMessageId(s);
          if (root) rootsOf.set(root, s.id);
        }
        const rootOf = (m: { id: string; parentId?: string }): string | null => {
          const byId = new Map(messages.map((x) => [x.id, x]));
          let current: { id: string; parentId?: string } | undefined = byId.get(m.id);
          while (current) {
            if (!current.parentId || !byId.has(current.parentId)) return current.id;
            current = byId.get(current.parentId);
          }
          return null;
        };
        const matches: Array<{
          id: string;
          role: string;
          timestamp: string;
          sessionId: string | null;
          superseded: boolean;
          excerpt: string;
        }> = [];
        for (const m of messages) {
          if (matches.length >= limit) break;
          if (!matchesQuery(m.content, args.query)) continue;
          const sid = rootsOf.get(rootOf(m) ?? '') ?? null;
          if (args.sessionId && sid !== args.sessionId) continue;
          matches.push({
            id: m.id,
            role: m.role,
            timestamp: m.timestamp,
            sessionId: sid,
            superseded: m.supersededBy !== undefined,
            excerpt: excerpt(m.content, args.query),
          });
        }
        return ok(
          { query: args.query, matches },
          matches.map((m) => ({
            sourceId: m.id,
            sourceType: 'conversation',
            hash: sha256(m.excerpt),
            excerpt: m.excerpt,
          })),
        );
      },
    },
  ];
}

function excerpt(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, 100);
  const start = Math.max(0, idx - 30);
  const end = Math.min(content.length, idx + query.length + 50);
  return content.slice(start, end);
}

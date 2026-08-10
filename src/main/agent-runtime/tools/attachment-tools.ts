/**
 * attachment-tools.ts — 附件读取工具（chat/organize 白名单）。
 * 只读。聊天消息只引用 attachmentId，不存正文（§3.2）。
 *
 * 默认会话内读取（Part 2）：list_attachments / read_attachment 只暴露
 * 当前 run 上下文消息引用的附件（attachmentScope，RunCoordinator 注入）；
 * 范围外读取硬性拒绝（ATTACHMENT_OUT_OF_SCOPE）。
 * 跨会话读取（list_all_attachments / read_any_attachment）仅在作者
 * 明确要求时使用（系统提示纪律门控，同「不得补写」等硬规则层级）。
 */
import type { ToolSpec } from '../tool-types';
import { AttachmentRepository } from '../../storage/attachment-repository';
import { sha256 } from '../../storage/hash';
import { ok, fail, attachmentEvidence, sliceToolContent } from './tool-utils';

export function makeAttachmentReadTools(projectDir: () => string): ToolSpec[] {
  const attachments = () => new AttachmentRepository(projectDir());

  /** 范围内附件列表；attachmentScope 缺省 = 不限制（工具直接执行，如单元测试）。 */
  const scoped = <T extends { id: string }>(list: T[], scope?: ReadonlySet<string>): T[] => {
    if (!scope) return list;
    return list.filter((m) => scope.has(m.id));
  };

  return [
    {
      name: 'list_attachments',
      description: '列出当前会话范围内引用的附件（id、名称、来源、大小、hash、时间戳），不含正文。',
      inputSchema: {
        type: 'object',
        properties: {},
      } as never,
      outputSchema: {} as never,
      async execute(ctx) {
        const list = scoped(attachments().listAttachments(), ctx.attachmentScope);
        return ok(
          {
            attachments: list.map((m) => ({
              id: m.id,
              name: m.name,
              source: m.source,
              size: m.size,
              hash: m.hash,
              mtime: m.mtime,
              createdAt: m.createdAt,
            })),
          },
          list.map((m) => attachmentEvidence(m.id, m.hash)),
        );
      },
    },

    {
      name: 'read_attachment',
      description: '分段读取单个附件正文与元数据（仅限当前会话范围内引用的附件）。默认最多 40000 字；range.hasMore=true 时用 range.end 继续。',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: '附件 id' },
          start: { type: 'number', description: '起始字符位置（缺省 0）' },
          maxChars: { type: 'number', description: '本段最大字符数（缺省 40000，最高 100000）' },
        },
        required: ['attachmentId'],
      } as never,
      outputSchema: {} as never,
      async execute(ctx, args: { attachmentId: string; start?: number; maxChars?: number }) {
        if (ctx.attachmentScope && !ctx.attachmentScope.has(args.attachmentId)) {
          return fail(
            'ATTACHMENT_OUT_OF_SCOPE',
            `附件 ${args.attachmentId} 不在当前会话范围内。只有作者明确要求查看其他会话/项目附件时，才可用 list_all_attachments / read_any_attachment 跨会话读取。`,
          );
        }
        const read = attachments().readAttachment(args.attachmentId);
        if (!read) return fail('ATTACHMENT_NOT_FOUND', `附件不存在: ${args.attachmentId}`);
        const sliced = sliceToolContent(read.content, args.start, args.maxChars);
        return ok(
          {
            id: read.meta.id,
            name: read.meta.name,
            source: read.meta.source,
            size: read.meta.size,
            content: sliced.content,
            range: sliced.range,
            hash: sha256(read.content),
            mtime: read.meta.mtime,
          },
          [attachmentEvidence(read.meta.id, sha256(read.content), sliced.content.slice(0, 200))],
          sliced.range.hasMore,
        );
      },
    },

    {
      name: 'list_all_attachments',
      description: '列出项目全部附件（跨会话，包括其他会话与已删除会话遗留的附件）。仅在作者明确要求读取其他会话/项目附件时使用。',
      inputSchema: {
        type: 'object',
        properties: {},
      } as never,
      outputSchema: {} as never,
      async execute() {
        const list = attachments().listAttachments();
        return ok(
          {
            attachments: list.map((m) => ({
              id: m.id,
              name: m.name,
              source: m.source,
              size: m.size,
              hash: m.hash,
              mtime: m.mtime,
              createdAt: m.createdAt,
            })),
          },
          list.map((m) => attachmentEvidence(m.id, m.hash)),
        );
      },
    },

    {
      name: 'read_any_attachment',
      description: '分段读取项目任意附件正文与元数据（跨会话）。默认最多 40000 字；仅在作者明确要求查看其他会话/项目附件时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: '附件 id' },
          start: { type: 'number', description: '起始字符位置（缺省 0）' },
          maxChars: { type: 'number', description: '本段最大字符数（缺省 40000，最高 100000）' },
        },
        required: ['attachmentId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { attachmentId: string; start?: number; maxChars?: number }) {
        const read = attachments().readAttachment(args.attachmentId);
        if (!read) return fail('ATTACHMENT_NOT_FOUND', `附件不存在: ${args.attachmentId}`);
        const sliced = sliceToolContent(read.content, args.start, args.maxChars);
        return ok(
          {
            id: read.meta.id,
            name: read.meta.name,
            source: read.meta.source,
            size: read.meta.size,
            content: sliced.content,
            range: sliced.range,
            hash: sha256(read.content),
            mtime: read.meta.mtime,
          },
          [attachmentEvidence(read.meta.id, sha256(read.content), sliced.content.slice(0, 200))],
          sliced.range.hasMore,
        );
      },
    },
  ];
}

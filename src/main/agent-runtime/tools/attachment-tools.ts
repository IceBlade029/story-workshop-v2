/**
 * attachment-tools.ts — 附件读取工具（chat/organize 白名单）。
 * 只读。聊天消息只引用 attachmentId，不存正文（§3.2）。
 */
import type { ToolSpec } from '../tool-types';
import { AttachmentRepository } from '../../storage/attachment-repository';
import { sha256 } from '../../storage/hash';
import { ok, fail, attachmentEvidence } from './tool-utils';

export function makeAttachmentReadTools(projectDir: () => string): ToolSpec[] {
  const attachments = () => new AttachmentRepository(projectDir());

  return [
    {
      name: 'list_attachments',
      description: '列出全部附件（id、名称、来源、大小、hash、时间戳），不含正文。',
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
      name: 'read_attachment',
      description: '读取单个附件的完整正文与元数据。',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: '附件 id' },
        },
        required: ['attachmentId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { attachmentId: string }) {
        const read = attachments().readAttachment(args.attachmentId);
        if (!read) return fail('ATTACHMENT_NOT_FOUND', `附件不存在: ${args.attachmentId}`);
        return ok(
          {
            id: read.meta.id,
            name: read.meta.name,
            source: read.meta.source,
            size: read.meta.size,
            content: read.content,
            hash: sha256(read.content),
            mtime: read.meta.mtime,
          },
          [attachmentEvidence(read.meta.id, sha256(read.content), read.content.slice(0, 200))],
        );
      },
    },
  ];
}

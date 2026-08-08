/**
 * attachment-repository.ts — 附件存储（ux-review §3）。
 *
 * attachments/<attachmentId>.md   # 附件正文
 * attachments/index.json          # 附件索引（id、name、source、size、hash、mtime、createdAt）
 *
 * 附件是项目的一等对象：聊天消息只引用 attachmentId，不存正文（§3.2）。
 * 附件 hash 用于新鲜度比对：被外部修改或重传后，附件行提示「已更新」（§3.1）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileExists, readJsonFile, readMarkdownFile, writeJsonFile, writeMarkdownFile } from '../file-store';
import { assertSafeId, resolveWithin } from './path-safety';
import { sha256 } from './hash';
import { generateId } from './id';
import type { Attachment } from '../../shared/types';

export class AttachmentRepository {
  constructor(private readonly projectDir: string) {}

  private indexFilePath(): string {
    return path.join(this.projectDir, 'attachments', 'index.json');
  }

  private contentFilePath(attachmentId: string): string {
    return resolveWithin(this.projectDir, 'attachments', `${assertSafeId(attachmentId, 'attachment')}.md`);
  }

  private readIndex(): Attachment[] {
    return readJsonFile<Attachment[]>(this.indexFilePath()) ?? [];
  }

  private writeIndex(index: Attachment[]): void {
    writeJsonFile(this.indexFilePath(), index);
  }

  /** 新建附件：写入正文文件并把索引条目（含 hash 与字节数）落盘。 */
  createAttachment(name: string, content: string, source: Attachment['source']): Attachment {
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateId('att'),
      name,
      source,
      size: Buffer.byteLength(content, 'utf-8'),
      hash: sha256(content),
      mtime: now,
      createdAt: now,
    };
    writeMarkdownFile(this.contentFilePath(attachment.id), content);
    const index = this.readIndex();
    index.push(attachment);
    this.writeIndex(index);
    return attachment;
  }

  /** 更新附件内容（与名称）；重传/外部修改后 hash 与 mtime 变化，驱动新鲜度比对。 */
  updateAttachment(id: string, content: string, name?: string): Attachment | null {
    const index = this.readIndex();
    const idx = index.findIndex((m) => m.id === id);
    if (idx < 0) return null;
    const now = new Date().toISOString();
    index[idx] = {
      ...index[idx],
      name: name ?? index[idx].name,
      size: Buffer.byteLength(content, 'utf-8'),
      hash: sha256(content),
      mtime: now,
    };
    writeMarkdownFile(this.contentFilePath(id), content);
    this.writeIndex(index);
    return index[idx];
  }

  /** 读取附件元数据 + 正文；不存在时返回 null。 */
  readAttachment(id: string): { meta: Attachment; content: string } | null {
    const meta = this.readIndex().find((m) => m.id === id);
    if (!meta) return null;
    return { meta, content: readMarkdownFile(this.contentFilePath(id)) };
  }

  /**
   * 记录一次整理任务消化此附件时的 hash（§4.3）。
   * 附件此后被外部修改或重传 → lastStructured.hash ≠ 当前 hash →
   * needsRestructure = true，附件行提示「已更新」。
   */
  markStructured(id: string, runId: string): Attachment | null {
    const index = this.readIndex();
    const idx = index.findIndex((m) => m.id === id);
    if (idx < 0) return null;
    index[idx] = {
      ...index[idx],
      lastStructured: { runId, hash: index[idx].hash, at: new Date().toISOString() },
    };
    this.writeIndex(index);
    return index[idx];
  }

  /**
   * 派生新鲜度（§4.3）：结构化后内容已变化（含外部修改与重传）
   * → needsRestructure = true。磁盘文件 hash 与索引 hash 不一致也算。
   */
  attachFreshness(attachments: Attachment[]): Attachment[] {
    return attachments.map((m) => {
      const currentHash = this.recomputeHash(m.id) ?? m.hash;
      const structured = m.lastStructured;
      return {
        ...m,
        needsRestructure: structured ? structured.hash !== currentHash : undefined,
      };
    });
  }

  readAttachmentMeta(id: string): Attachment | null {
    return this.readIndex().find((m) => m.id === id) ?? null;
  }

  /** 按磁盘上的实际文件重新计算 hash（用于外部修改检测）。 */
  recomputeHash(id: string): string | null {
    const contentFilePath = this.contentFilePath(id);
    if (!fileExists(contentFilePath)) return null;
    return sha256(fs.readFileSync(contentFilePath, 'utf-8'));
  }

  deleteAttachment(id: string): void {
    const index = this.readIndex().filter((m) => m.id !== id);
    this.writeIndex(index);
    try {
      if (fileExists(this.contentFilePath(id))) fs.unlinkSync(this.contentFilePath(id));
    } catch {
      /* best effort */
    }
  }

  listAttachments(): Attachment[] {
    return this.readIndex();
  }
}

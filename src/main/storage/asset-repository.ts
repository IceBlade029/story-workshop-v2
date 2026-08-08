/**
 * asset-repository.ts — 设定空间存储（design doc §3.6、§4.1、§4.2）。
 *
 * world/<assetId>.md           # 设定正文（markdown 自由格式）
 * world/index.json             # 设定索引（id、type、title、hash、createdAt、updatedAt）
 *
 * 设定是项目内部真相，没有草稿/正式之分（§3.6）。错误靠快照回滚兜底。
 * 索引里的 hash 用于新鲜度比对：AI 基于旧设定改写时若设定已变更，
 * 回滚/重新整理时按 hash 对照（§4.3）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileExists, readJsonFile, readMarkdownFile, writeJsonFile, writeMarkdownFile } from '../file-store';
import { assertSafeId, resolveWithin } from './path-safety';
import { sha256 } from './hash';
import { generateId } from './id';
import type { Asset } from '../../shared/types';

export class AssetRepository {
  constructor(private readonly projectDir: string) {}

  private indexFilePath(): string {
    return path.join(this.projectDir, 'world', 'index.json');
  }

  private contentFilePath(assetId: string): string {
    return resolveWithin(this.projectDir, 'world', `${assertSafeId(assetId, 'asset')}.md`);
  }

  private readIndex(): Asset[] {
    return readJsonFile<Asset[]>(this.indexFilePath()) ?? [];
  }

  private writeIndex(index: Asset[]): void {
    writeJsonFile(this.indexFilePath(), index);
  }

  /** 新建设定：type 是自由字符串 + 建议预设，不强制 schema（§3.6）。 */
  createAsset(type: string, title: string, content: string): Asset {
    const now = new Date().toISOString();
    const asset: Asset = {
      id: generateId('ast'),
      type,
      title,
      content,
      hash: sha256(content),
      createdAt: now,
      updatedAt: now,
    };
    writeMarkdownFile(this.contentFilePath(asset.id), content);
    const index = this.readIndex();
    index.push(asset);
    this.writeIndex(index);
    return asset;
  }

  /** 更新设定；写出来的就是事实，错误靠快照回滚兜底（§3.6）。 */
  updateAsset(
    id: string,
    updates: { type?: string; title?: string; content?: string },
  ): Asset | null {
    const index = this.readIndex();
    const idx = index.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const existing = index[idx];
    const content = updates.content ?? existing.content;
    const updated: Asset = {
      ...existing,
      type: updates.type ?? existing.type,
      title: updates.title ?? existing.title,
      content,
      hash: sha256(content),
      updatedAt: new Date().toISOString(),
    };
    writeMarkdownFile(this.contentFilePath(id), content);
    index[idx] = updated;
    this.writeIndex(index);
    return updated;
  }

  /** 读取完整设定（索引 + 正文）；不存在时返回 null。 */
  readAsset(id: string): Asset | null {
    const index = this.readIndex();
    const meta = index.find((a) => a.id === id);
    if (!meta) return null;
    return { ...meta, content: readMarkdownFile(this.contentFilePath(id)) };
  }

  deleteAsset(id: string): void {
    this.writeIndex(this.readIndex().filter((a) => a.id !== id));
    try {
      if (fileExists(this.contentFilePath(id))) fs.unlinkSync(this.contentFilePath(id));
    } catch {
      /* best effort */
    }
  }

  listAssets(): Asset[] {
    return this.readIndex();
  }
}

/**
 * output-repository.ts — 正文输出存储（design doc §3.5、§4.1、§4.3）。
 *
 * outputs/<sceneId>.<format>.md  # 生成的正文，不随窗口关闭丢失
 * outputs/index.json             # 输出索引（记录生成时所依据的可见视图 hash，
 *                                # 支撑「视图变更 → 输出失效」检测）
 *
 * 来源（可见视图）变更后输出自动标失效（§3.5）；支持基于上一版输出的
 * 反馈重生成（输入为旧输出 + 反馈，仍只读可见视图，§6.5）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, fileExists, readJsonFile, readMarkdownFile, writeJsonFile, writeMarkdownFile } from '../file-store';
import { assertSafeFormat, assertSafeId, resolveWithin } from './path-safety';
import type { OutputInfo } from '../../shared/ipc-types';

export interface OutputIndexEntry {
  sceneId: string;
  format: string;
  /** 生成时所依据的可见视图内容 hash */
  viewHash: string;
  generatedAt: string;
}

interface OutputIndexFile {
  version: 1;
  entries: Record<string, OutputIndexEntry>;
}

export class OutputRepository {
  constructor(private readonly projectDir: string) {}

  private outputFilePath(sceneId: string, format: string): string {
    const safeSceneId = assertSafeId(sceneId, 'scene');
    const safeFormat = assertSafeFormat(format);
    return resolveWithin(this.projectDir, 'outputs', `${safeSceneId}.${safeFormat}.md`);
  }

  private indexPath(): string {
    return path.join(this.projectDir, 'outputs', 'index.json');
  }

  private readIndex(): Record<string, OutputIndexEntry> {
    const index = readJsonFile<OutputIndexFile>(this.indexPath());
    return index?.entries ?? {};
  }

  private writeIndex(entries: Record<string, OutputIndexEntry>): void {
    ensureDir(path.dirname(this.indexPath()));
    writeJsonFile(this.indexPath(), { version: 1, entries } satisfies OutputIndexFile);
  }

  /** 写正文并记录生成时所依据的可见视图 hash（视图变更 → 输出失效，§3.5）。 */
  write(sceneId: string, format: string, content: string, viewHash: string): void {
    writeMarkdownFile(this.outputFilePath(sceneId, format), content);
    const entries = this.readIndex();
    entries[`${sceneId}.${format}`] = { sceneId, format, viewHash, generatedAt: new Date().toISOString() };
    this.writeIndex(entries);
  }

  read(sceneId: string, format: string): string {
    return readMarkdownFile(this.outputFilePath(sceneId, format));
  }

  exists(sceneId: string, format: string): boolean {
    return fileExists(this.outputFilePath(sceneId, format));
  }

  /** 某场景已生成的媒介列表（不含扩展名）。 */
  listFormatsForScene(sceneId: string): string[] {
    const dir = path.join(this.projectDir, 'outputs');
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${sceneId}.`) && f.endsWith('.md'))
        .map((f) => f.slice(sceneId.length + 1, -'.md'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 某场景的输出列表（含失效标记，§3.5）。
   * currentViewHash = 当前可见视图内容 hash；null = 视图不存在（输出一律失效）。
   */
  listForScene(sceneId: string, currentViewHash: string | null): OutputInfo[] {
    const entries = this.readIndex();
    return this.listFormatsForScene(sceneId).map((format) => {
      const entry = entries[`${sceneId}.${format}`];
      return {
        format,
        stale: entry ? entry.viewHash !== (currentViewHash ?? '') : false,
        generatedAt: entry?.generatedAt ?? '',
      };
    });
  }

  /** 删除某场景的全部输出与索引条目（节点删除时清理，§9.4）。 */
  deleteForScene(sceneId: string): void {
    const entries = this.readIndex();
    let changed = false;
    for (const key of Object.keys(entries)) {
      if (key.startsWith(`${sceneId}.`)) {
        delete entries[key];
        changed = true;
      }
    }
    if (changed) this.writeIndex(entries);
    for (const format of this.listFormatsForScene(sceneId)) {
      try {
        fs.unlinkSync(this.outputFilePath(sceneId, format));
      } catch {
        /* best effort */
      }
    }
  }
}

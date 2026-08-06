/**
 * trash-repository.ts — 项目回收站（design doc §9.4）。
 *
 * trash/index.json             # 条目索引
 * trash/<trashId>/             # 被移入的内容
 *   outline-entry.json         #   { node: OutlineNode 子树, parentId }
 *   nodes/<id>.md|.draft.md|.meta.json   # 节点内容（被移动的文件）
 *   visible_views/<id>.json    # 可见视图（已被正文引用的内容保留最小证据，§9.4）
 *   outputs/<id>.*.md          # 已生成正文
 *
 * 节点删除先进回收站（删除即移入），永久删除需单独确认。恢复 = 文件移回 +
 * 子树重新插入大纲（原父节点已不存在时挂回总纲根）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from '../file-store';
import { generateId } from './id';
import { OutlineRepository } from './outline-repository';
import type { OutlineNode, NodeType } from '../../shared/types';
import type { TrashEntry } from '../../shared/ipc-types';

interface StoredTrashEntry extends TrashEntry {
  /** 移入时保存的相对路径清单（回滚/恢复用） */
  files: string[];
  /** 移入时的子树结构与原父节点 id */
  node: OutlineNode;
}

const MOVED_DIRS = ['nodes', 'visible_views', 'outputs'];

export class TrashRepository {
  constructor(private readonly projectDir: string, private readonly outline: OutlineRepository) {}

  private trashDir(): string {
    return path.join(this.projectDir, 'trash');
  }

  private indexPath(): string {
    return path.join(this.trashDir(), 'index.json');
  }

  private entryDir(trashId: string): string {
    return path.join(this.trashDir(), trashId);
  }

  private readIndex(): StoredTrashEntry[] {
    return readJsonFile<StoredTrashEntry[]>(this.indexPath()) ?? [];
  }

  private writeIndex(entries: StoredTrashEntry[]): void {
    writeJsonFile(this.indexPath(), entries);
  }

  private getEntry(trashId: string): StoredTrashEntry | null {
    return this.readIndex().find((e) => e.id === trashId) ?? null;
  }

  /** 收集子树全部节点 id（含自身）。 */
  private collectSubtree(node: OutlineNode): string[] {
    const ids: string[] = [node.id];
    for (const child of node.children) ids.push(...this.collectSubtree(child));
    return ids;
  }

  /**
   * 把节点（含整棵子树）移入回收站：内容文件移动到 trash/<trashId>/，
   * 子树从大纲树移除。已生成正文/可见视图随内容保留（最小证据快照，§9.4）。
   */
  moveToTrash(nodeId: string): TrashEntry {
    const node = this.outline.findNode(nodeId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
    const parent = this.outline.findParent(nodeId);
    const trashId = `${Date.now()}-${nodeId}`;
    const targetDir = this.entryDir(trashId);
    ensureDir(targetDir);

    // 1) 移动内容文件
    const files: string[] = [];
    const subtreeIds = this.collectSubtree(node);
    for (const id of subtreeIds) {
      for (const f of this.nodeFiles(id)) {
        if (!fileExists(f)) continue;
        const relative = this.toPortableRelative(f);
        if (!relative) continue;
        const dest = path.join(targetDir, ...relative.split('/'));
        ensureDir(path.dirname(dest));
        fs.copyFileSync(f, dest);
        fs.unlinkSync(f);
        files.push(relative);
      }
    }
    this.cleanOutputsIndex(subtreeIds);

    // 2) 从大纲树移除（内容文件已移走，不再删文件）
    this.outline.removeNode(nodeId);

    // 3) 记录条目
    const entry: StoredTrashEntry = {
      id: trashId,
      nodeId,
      title: node.title,
      type: node.type,
      parentId: parent?.id ?? null,
      subtreeIds,
      movedAt: new Date().toISOString(),
      files,
      node,
    };
    writeJsonFile(path.join(targetDir, 'outline-entry.json'), { node, parentId: entry.parentId });
    this.writeIndex([...this.readIndex(), entry]);
    return entry;
  }

  /** 恢复：文件移回项目，子树重新插入大纲（原父节点不存在 → 挂回总纲根）。 */
  restore(trashId: string): TrashEntry {
    const entry = this.getEntry(trashId);
    if (!entry) throw new Error(`TRASH_ENTRY_NOT_FOUND: ${trashId}`);
    if (this.outline.findNode(entry.nodeId)) throw new Error('NODE_ID_CONFLICT');

    // 1) 文件移回
    const srcDir = this.entryDir(trashId);
    for (const relative of entry.files) {
      const src = path.join(srcDir, ...relative.split('/'));
      if (!fileExists(src)) continue;
      const dest = path.join(this.projectDir, ...relative.split('/'));
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }

    // 2) 子树重新插入（原父节点已不存在 → 总纲根）
    let parentId = entry.parentId;
    if (!parentId || !this.outline.findNode(parentId)) parentId = 'overview';
    this.outline.createNode(parentId, entry.node);

    // 3) 移除条目与目录
    this.removeEntry(trashId);
    return entry;
  }

  /** 永久删除（§9.4：需单独确认）。 */
  purge(trashId: string): TrashEntry {
    const entry = this.getEntry(trashId);
    if (!entry) throw new Error(`TRASH_ENTRY_NOT_FOUND: ${trashId}`);
    this.removeEntry(trashId);
    return entry;
  }

  list(): TrashEntry[] {
    return this.readIndex().map(({ node: _node, files: _files, ...entry }) => entry);
  }

  /** 清空回收站（供测试与设置项）。 */
  empty(): string[] {
    const entries = this.readIndex().map((e) => e.id);
    for (const id of entries) this.removeEntry(id);
    return entries;
  }

  private removeEntry(trashId: string): void {
    this.writeIndex(this.readIndex().filter((e) => e.id !== trashId));
    try {
      fs.rmSync(this.entryDir(trashId), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** 节点关联的全部文件路径（nodes/*、visible_views/*、outputs/*）。 */
  private nodeFiles(nodeId: string): string[] {
    const files: string[] = [
      path.join(this.projectDir, 'nodes', `${nodeId}.md`),
      path.join(this.projectDir, 'nodes', `${nodeId}.draft.md`),
      path.join(this.projectDir, 'nodes', `${nodeId}.meta.json`),
      path.join(this.projectDir, 'visible_views', `${nodeId}.json`),
    ];
    const outputsDir = path.join(this.projectDir, 'outputs');
    try {
      for (const f of fs.readdirSync(outputsDir)) {
        if (f.startsWith(`${nodeId}.`) && f.endsWith('.md')) {
          files.push(path.join(outputsDir, f));
        }
      }
    } catch {
      /* outputs 目录不存在 */
    }
    return files;
  }

  /** 输出索引里这些场景的条目一并清理（文件已随回收站保留）。 */
  private cleanOutputsIndex(sceneIds: string[]): void {
    const indexPath = path.join(this.projectDir, 'outputs', 'index.json');
    const index = readJsonFile<{ version: 1; entries: Record<string, unknown> }>(indexPath);
    if (!index) return;
    let changed = false;
    for (const id of sceneIds) {
      for (const key of Object.keys(index.entries)) {
        if (key.startsWith(`${id}.`)) {
          delete index.entries[key];
          changed = true;
        }
      }
    }
    if (changed) writeJsonFile(indexPath, index);
  }

  private toPortableRelative(file: string): string | null {
    const relative = path.relative(this.projectDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  }
}

export type { NodeType };

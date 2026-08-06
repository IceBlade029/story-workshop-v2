/**
 * outline-repository.ts — 大纲树仓库（design doc §3.1、§4.1、§4.2）。
 *
 * 文件布局：
 *   outline.json                # 树结构：id、type、title、children 顺序、AI 新增标记
 *   nodes/<nodeId>.md           # 正式版内容
 *   nodes/<nodeId>.draft.md     # 草稿内容
 *   nodes/<nodeId>.meta.json    # 官方/草稿 hash、可见视图状态、时间戳
 *
 * 新鲜度全部由 hash 比对驱动（§4.3）：writeOfficial / writeDraft 自动
 * 把内容 hash 写入 meta。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileExists, readJsonFile, readMarkdownFile, writeJsonFile, writeMarkdownFile } from '../file-store';
import { sha256 } from './hash';
import { generateId } from './id';
import type { OutlineNode, OutlineTree } from '../../shared/types';

/** 大纲根节点（overview）的固定 id。 */
export const OVERVIEW_ROOT_ID = 'overview';

export interface NodeMeta {
  createdAt: string;
  updatedAt: string;
  /** 正式版内容 hash（nodes/<id>.md） */
  officialHash?: string;
  /** 草稿内容 hash（nodes/<id>.draft.md） */
  draftHash?: string;
  /** 可见视图状态（M5 使用；记录于此以支撑失效检测） */
  visibleView?: {
    exists: boolean;
    sourceHash?: string;
    userEdited?: boolean;
    needsRegeneration?: boolean;
    generatedAt?: string;
  };
}

export const OVERVIEW_TITLE = '总纲';

export function emptyOutlineTree(): OutlineTree {
  const root: OutlineNode = {
    id: OVERVIEW_ROOT_ID,
    type: 'overview',
    title: OVERVIEW_TITLE,
    children: [],
  };
  return { version: 1, root };
}

export class OutlineRepository {
  constructor(private readonly projectDir: string) {}

  // ------------------------------------------------------------------ tree

  private outlineFilePath(): string {
    return path.join(this.projectDir, 'outline.json');
  }

  /** 读取大纲树；文件不存在时返回 null（新项目由 project-repository 初始化）。 */
  readTree(): OutlineTree | null {
    return readJsonFile<OutlineTree>(this.outlineFilePath());
  }

  saveTree(tree: OutlineTree): void {
    writeJsonFile(this.outlineFilePath(), tree);
  }

  findNode(nodeId: string): OutlineNode | null {
    const tree = this.readTree();
    if (!tree) return null;
    return this.findNodeIn(tree.root, nodeId);
  }

  private findNodeIn(node: OutlineNode, nodeId: string): OutlineNode | null {
    if (node.id === nodeId) return node;
    for (const child of node.children) {
      const found = this.findNodeIn(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  /** 找到 nodeId 的父节点；nodeId 是根节点时返回 null。 */
  findParent(nodeId: string): OutlineNode | null {
    const tree = this.readTree();
    if (!tree || tree.root.id === nodeId) return null;
    return this.findParentIn(tree.root, nodeId);
  }

  private findParentIn(node: OutlineNode, nodeId: string): OutlineNode | null {
    for (const child of node.children) {
      if (child.id === nodeId) return node;
      const found = this.findParentIn(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  /**
   * 在父节点 children 的指定位置插入新节点（index 缺省 = 追加末尾）。
   *
   * §3.1 隐藏中间层级：父节点为 volume 且新节点为 scene 时，自动插入隐藏的
   * chapter（hidden: true）承托该场景，保持「卷 > 章 > 场景」层级；渲染层
   * 跳过隐藏节点、把场景提升一层显示。scene 是叶子节点，不允许创建子节点。
   */
  createNode(parentId: string, node: OutlineNode, index?: number): OutlineNode {
    const tree = this.readTree();
    if (!tree) throw new Error('OUTLINE_NOT_INITIALIZED');
    const parent = this.findNodeIn(tree.root, parentId);
    if (!parent) throw new Error(`NODE_NOT_FOUND: ${parentId}`);
    if (parent.type === 'scene') throw new Error('CANNOT_ADD_CHILD_TO_SCENE');
    const now = new Date().toISOString();

    if (parent.type === 'volume' && node.type === 'scene') {
      const hiddenChapter: OutlineNode = {
        id: generateId('n'),
        type: 'chapter',
        title: '章节',
        hidden: true,
        children: [node],
      };
      if (index === undefined) {
        parent.children.push(hiddenChapter);
      } else {
        parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, hiddenChapter);
      }
      this.saveTree(tree);
      this.writeMeta(hiddenChapter.id, { createdAt: now, updatedAt: now });
      this.writeMeta(node.id, { createdAt: now, updatedAt: now });
      return node;
    }

    if (index === undefined) {
      parent.children.push(node);
    } else {
      parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, node);
    }
    this.saveTree(tree);
    this.writeMeta(node.id, {
      createdAt: now,
      updatedAt: now,
    });
    return node;
  }

  /** 从树中移除节点（含整棵子树）。文件内容不动——删除进回收站由调用方决定（§9.4）。 */
  removeNode(nodeId: string): void {
    const tree = this.readTree();
    if (!tree) throw new Error('OUTLINE_NOT_INITIALIZED');
    if (tree.root.id === nodeId) throw new Error('CANNOT_REMOVE_ROOT');
    if (!this.removeFrom(tree.root, nodeId)) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
    this.saveTree(tree);
  }

  private removeFrom(node: OutlineNode, nodeId: string): boolean {
    const idx = node.children.findIndex((c) => c.id === nodeId);
    if (idx >= 0) {
      node.children.splice(idx, 1);
      return true;
    }
    for (const child of node.children) {
      if (this.removeFrom(child, nodeId)) return true;
    }
    return false;
  }

  renameNode(nodeId: string, title: string): void {
    const tree = this.readTree();
    if (!tree) throw new Error('OUTLINE_NOT_INITIALIZED');
    const node = this.findNodeIn(tree.root, nodeId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
    node.title = title;
    this.saveTree(tree);
    this.touchMeta(nodeId);
  }

  /** 移动节点到新父节点下（index 缺省 = 追加末尾）。 */
  moveNode(nodeId: string, newParentId: string, index?: number): void {
    const tree = this.readTree();
    if (!tree) throw new Error('OUTLINE_NOT_INITIALIZED');
    if (nodeId === tree.root.id) throw new Error('CANNOT_MOVE_ROOT');
    if (nodeId === newParentId) throw new Error('CANNOT_MOVE_INTO_SELF');
    const node = this.findNodeIn(tree.root, nodeId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
    if (this.findNodeIn(node, newParentId)) throw new Error('CANNOT_MOVE_INTO_DESCENDANT');
    const newParent = this.findNodeIn(tree.root, newParentId);
    if (!newParent) throw new Error(`NODE_NOT_FOUND: ${newParentId}`);

    // 先从旧父节点移除，再插入新父节点（同一棵树，先移除后插入安全）。
    this.removeFrom(tree.root, nodeId);
    if (index === undefined) {
      newParent.children.push(node);
    } else {
      newParent.children.splice(Math.max(0, Math.min(index, newParent.children.length)), 0, node);
    }
    this.saveTree(tree);
    this.touchMeta(nodeId);
  }

  // -------------------------------------------------------------- content

  private officialFilePath(nodeId: string): string {
    return path.join(this.projectDir, 'nodes', `${nodeId}.md`);
  }

  private draftFilePath(nodeId: string): string {
    return path.join(this.projectDir, 'nodes', `${nodeId}.draft.md`);
  }

  readOfficial(nodeId: string): string {
    return readMarkdownFile(this.officialFilePath(nodeId));
  }

  hasOfficial(nodeId: string): boolean {
    return fileExists(this.officialFilePath(nodeId));
  }

  /** 写正式版内容，并自动更新 meta 中的 officialHash。 */
  writeOfficial(nodeId: string, content: string): void {
    writeMarkdownFile(this.officialFilePath(nodeId), content);
    const meta = this.readMeta(nodeId);
    meta.officialHash = sha256(content);
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(nodeId, meta);
  }

  readDraft(nodeId: string): string {
    return readMarkdownFile(this.draftFilePath(nodeId));
  }

  hasDraft(nodeId: string): boolean {
    return fileExists(this.draftFilePath(nodeId));
  }

  /** 写草稿内容，并自动更新 meta 中的 draftHash。 */
  writeDraft(nodeId: string, content: string): void {
    writeMarkdownFile(this.draftFilePath(nodeId), content);
    const meta = this.readMeta(nodeId);
    meta.draftHash = sha256(content);
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(nodeId, meta);
  }

  /** 删除节点的全部文件（正式版、草稿、meta）。调用方负责回收站语义。 */
  deleteNodeFiles(nodeId: string): void {
    const files = [
      this.officialFilePath(nodeId),
      this.draftFilePath(nodeId),
      this.metaFilePath(nodeId),
    ];
    for (const f of files) {
      try {
        if (fileExists(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }

  // ------------------------------------------------------------------ meta

  private metaFilePath(nodeId: string): string {
    return path.join(this.projectDir, 'nodes', `${nodeId}.meta.json`);
  }

  /** 读取节点 meta；不存在时返回默认空 meta（不写入磁盘）。 */
  readMeta(nodeId: string): NodeMeta {
    return (
      readJsonFile<NodeMeta>(this.metaFilePath(nodeId)) ?? {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    );
  }

  writeMeta(nodeId: string, meta: NodeMeta): void {
    writeJsonFile(this.metaFilePath(nodeId), meta);
  }

  private touchMeta(nodeId: string): void {
    const meta = this.readMeta(nodeId);
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(nodeId, meta);
  }

  /** 扫描 nodes/ 目录，返回全部节点 id。 */
  listNodeIds(): string[] {
    const nodesDir = path.join(this.projectDir, 'nodes');
    try {
      return fs.readdirSync(nodesDir)
        .filter((f) => f.endsWith('.meta.json'))
        .map((f) => f.replace(/\.meta\.json$/, ''));
    } catch {
      return [];
    }
  }

  /**
   * 清除指定节点的 aiCreated 标记（§5.4「接受」：保留草稿，清除 AI 新增标记）。
   * 只清除仍在树中的节点。
   */
  clearAiCreated(nodeIds: string[]): void {
    const tree = this.readTree();
    if (!tree) return;
    let changed = false;
    for (const id of nodeIds) {
      const node = this.findNodeIn(tree.root, id);
      if (node && node.aiCreated) {
        delete node.aiCreated;
        changed = true;
      }
    }
    if (changed) this.saveTree(tree);
  }
}

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { OutlineRepository, emptyOutlineTree, OVERVIEW_ROOT_ID } from '../../storage/outline-repository';
import { sha256 } from '../../storage/hash';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { OutlineNode } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeOutline(): { outline: OutlineRepository; projectDir: string } {
  const { projectDir } = makeProject();
  tempDirs.push(path.dirname(projectDir));
  return { outline: new OutlineRepository(projectDir), projectDir };
}

function node(id: string, type: OutlineNode['type'], title: string, children: OutlineNode[] = []): OutlineNode {
  return { id, type, title, children };
}

describe('outline-repository — 树结构', () => {
  beforeEach(() => {
    /* noop */
  });

  it('项目创建后存在带总纲根的空树', () => {
    const { outline } = makeOutline();
    const tree = outline.readTree();
    expect(tree).not.toBeNull();
    expect(tree!.root.id).toBe(OVERVIEW_ROOT_ID);
    expect(tree!.root.children).toEqual([]);
  });

  it('readTree 对未初始化目录返回 null', () => {
    const { projectDir } = makeProject();
    tempDirs.push(path.dirname(projectDir));
    fs.unlinkSync(path.join(projectDir, 'outline.json'));
    const outline = new OutlineRepository(projectDir);
    expect(outline.readTree()).toBeNull();
  });

  it('createNode 追加子节点并写入 meta 文件', () => {
    const { outline, projectDir } = makeOutline();
    const vol = node('v1', 'volume', '第一卷');
    outline.createNode(OVERVIEW_ROOT_ID, vol);
    const scene = node('s1', 'scene', '第一场');
    outline.createNode('v1', scene);
    expect(outline.findNode('s1')?.title).toBe('第一场');
    expect(fs.existsSync(path.join(projectDir, 'nodes', 's1.meta.json'))).toBe(true);
    expect(outline.readMeta('s1').createdAt).toBeTruthy();
  });

  it('§3.1 隐藏中间层级：卷下建场景自动插入隐藏章，场景挂到隐藏章下', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', '第一卷'));
    outline.createNode('v1', node('s1', 'scene', '第一场'));
    const hidden = outline.findParent('s1');
    expect(hidden?.type).toBe('chapter');
    expect(hidden?.hidden).toBe(true);
    expect(outline.findParent(hidden!.id)?.id).toBe('v1');
    // 隐藏章也写 meta
    expect(outline.readMeta(hidden!.id).createdAt).toBeTruthy();
  });

  it('§3.1 隐藏中间层级：正常层级不插入；场景是叶子节点', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', '卷'));
    outline.createNode('v1', node('c1', 'chapter', '章')); // 卷 > 章：正常
    outline.createNode('c1', node('s1', 'scene', '场景')); // 章 > 场景：正常
    outline.createNode(OVERVIEW_ROOT_ID, node('s2', 'scene', '总纲下场景')); // 总纲 > 场景：正常
    expect(outline.findParent('s1')?.id).toBe('c1');
    expect(outline.findParent('c1')?.id).toBe('v1');
    expect(outline.findParent('s2')?.id).toBe(OVERVIEW_ROOT_ID);
    // 场景下不允许创建子节点
    expect(() => outline.createNode('s1', node('x', 'scene', 'X'))).toThrow('CANNOT_ADD_CHILD_TO_SCENE');
  });

  it('createNode 按 index 插入', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('a', 'volume', 'A'));
    outline.createNode(OVERVIEW_ROOT_ID, node('c', 'volume', 'C'));
    outline.createNode(OVERVIEW_ROOT_ID, node('b', 'volume', 'B'), 1);
    const tree = outline.readTree()!;
    expect(tree.root.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('createNode 对不存在的父节点抛错', () => {
    const { outline } = makeOutline();
    expect(() => outline.createNode('nope', node('x', 'scene', 'X'))).toThrow('NODE_NOT_FOUND');
  });

  it('createNode 保留 aiCreated 标记', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V', []), undefined);
    outline.createNode(OVERVIEW_ROOT_ID, { ...node('n1', 'chapter', 'AI 新增章'), aiCreated: true });
    expect(outline.findNode('n1')?.aiCreated).toBe(true);
  });

  it('removeNode 移除整棵子树；根节点与缺失节点抛错', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V'));
    outline.createNode('v1', node('c1', 'chapter', 'C'));
    outline.removeNode('v1');
    expect(outline.findNode('c1')).toBeNull();
    expect(outline.findNode('v1')).toBeNull();
    expect(() => outline.removeNode(OVERVIEW_ROOT_ID)).toThrow('CANNOT_REMOVE_ROOT');
    expect(() => outline.removeNode('ghost')).toThrow('NODE_NOT_FOUND');
  });

  it('renameNode 更新标题并 touch meta', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', '旧标题'));
    outline.renameNode('v1', '新标题');
    expect(outline.findNode('v1')?.title).toBe('新标题');
    expect(() => outline.renameNode('ghost', 'X')).toThrow('NODE_NOT_FOUND');
  });

  it('moveNode 移动节点到新父节点', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.createNode(OVERVIEW_ROOT_ID, node('v2', 'volume', 'V2'));
    outline.createNode('v1', node('c1', 'chapter', 'C1'));
    outline.moveNode('c1', 'v2');
    expect(outline.findParent('c1')?.id).toBe('v2');
    expect(outline.findNode('v1')?.children).toEqual([]);
  });

  it('moveNode 禁止移动根节点 / 移入自身 / 移入后代', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.createNode('v1', node('c1', 'chapter', 'C1'));
    expect(() => outline.moveNode(OVERVIEW_ROOT_ID, 'v1')).toThrow('CANNOT_MOVE_ROOT');
    expect(() => outline.moveNode('v1', 'v1')).toThrow('CANNOT_MOVE_INTO_SELF');
    expect(() => outline.moveNode('v1', 'c1')).toThrow('CANNOT_MOVE_INTO_DESCENDANT');
  });

  it('saveTree 保存空树后可读回', () => {
    const { outline } = makeOutline();
    outline.saveTree(emptyOutlineTree());
    expect(outline.readTree()!.root.children).toEqual([]);
  });
});

describe('outline-repository — 内容与 hash 元数据', () => {
  it('writeOfficial 落盘并自动写入 officialHash', () => {
    const { outline, projectDir } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.writeOfficial('v1', '# 正文内容');
    const content = fs.readFileSync(path.join(projectDir, 'nodes', 'v1.md'), 'utf-8');
    expect(content).toBe('# 正文内容');
    expect(outline.readMeta('v1').officialHash).toBe(sha256('# 正文内容'));
    expect(outline.hasOfficial('v1')).toBe(true);
    expect(outline.readOfficial('v1')).toBe('# 正文内容');
  });

  it('writeDraft 落盘并自动写入 draftHash；重复写更新 hash', () => {
    const { outline, projectDir } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.writeDraft('v1', '草稿一');
    expect(fs.existsSync(path.join(projectDir, 'nodes', 'v1.draft.md'))).toBe(true);
    expect(outline.hasDraft('v1')).toBe(true);
    const h1 = outline.readMeta('v1').draftHash;
    expect(h1).toBe(sha256('草稿一'));
    outline.writeDraft('v1', '草稿二');
    expect(outline.readMeta('v1').draftHash).toBe(sha256('草稿二'));
    expect(outline.readMeta('v1').draftHash).not.toBe(h1);
  });

  it('readMeta 对缺失文件返回默认 meta 且不写盘', () => {
    const { outline, projectDir } = makeOutline();
    const meta = outline.readMeta('ghost');
    expect(meta.officialHash).toBeUndefined();
    expect(meta.createdAt).toBeTruthy();
    expect(fs.existsSync(path.join(projectDir, 'nodes', 'ghost.meta.json'))).toBe(false);
  });

  it('writeMeta 可写入可见视图状态字段', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('s1', 'scene', 'S1'));
    outline.writeMeta('s1', {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      visibleView: { exists: true, sourceHash: 'h1', userEdited: false, needsRegeneration: false },
    });
    expect(outline.readMeta('s1').visibleView?.sourceHash).toBe('h1');
  });

  it('deleteNodeFiles 删除正式版/草稿/meta 全部文件', () => {
    const { outline, projectDir } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.writeOfficial('v1', '正式');
    outline.writeDraft('v1', '草稿');
    outline.deleteNodeFiles('v1');
    for (const f of ['v1.md', 'v1.draft.md', 'v1.meta.json']) {
      expect(fs.existsSync(path.join(projectDir, 'nodes', f))).toBe(false);
    }
  });

  it('listNodeIds 扫描 meta 文件', () => {
    const { outline } = makeOutline();
    outline.createNode(OVERVIEW_ROOT_ID, node('v1', 'volume', 'V1'));
    outline.createNode('v1', node('c1', 'chapter', 'C1'));
    const ids = outline.listNodeIds().sort();
    expect(ids).toEqual(['c1', 'v1']);
  });
});

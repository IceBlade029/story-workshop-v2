import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectRepository, PROJECT_LAYOUT_DIRS } from '../../storage/project-repository';
import { OVERVIEW_ROOT_ID, OVERVIEW_TITLE } from '../../storage/outline-repository';
import { makeProject, makeTempDir, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

describe('project-repository', () => {
  it('create 写入 project.json 并铺好全部布局目录', () => {
    const { projectDir, repo } = makeProject('我的故事');
    tempDirs.push(path.dirname(projectDir));
    const meta = repo.getMeta();
    expect(meta.name).toBe('我的故事');
    expect(meta.createdAt).toBeTruthy();
    expect(meta.updatedAt).toBeTruthy();
    expect(meta.id).toMatch(/^proj_/);
    for (const dir of PROJECT_LAYOUT_DIRS) {
      expect(fs.existsSync(path.join(projectDir, dir))).toBe(true);
    }
  });

  it('create 初始化空大纲树（总纲根节点）', () => {
    const { projectDir, repo } = makeProject();
    tempDirs.push(path.dirname(projectDir));
    const tree = JSON.parse(fs.readFileSync(path.join(projectDir, 'outline.json'), 'utf-8'));
    expect(tree.root.id).toBe(OVERVIEW_ROOT_ID);
    expect(tree.root.type).toBe('overview');
    expect(tree.root.title).toBe(OVERVIEW_TITLE);
    expect(tree.root.children).toEqual([]);
    expect(repo).toBeInstanceOf(ProjectRepository);
  });

  it('open 对没有 project.json 的目录返回 null', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    expect(ProjectRepository.open(dir)).toBeNull();
  });

  it('open 读取已有项目，getMeta 与磁盘一致', () => {
    const { projectDir } = makeProject('重新打开');
    tempDirs.push(path.dirname(projectDir));
    const opened = ProjectRepository.open(projectDir);
    expect(opened).not.toBeNull();
    expect(opened!.getMeta().name).toBe('重新打开');
  });

  it('rename 更新名称与 updatedAt', () => {
    const { projectDir } = makeProject('旧名');
    tempDirs.push(path.dirname(projectDir));
    const opened = ProjectRepository.open(projectDir)!;
    opened.rename('新名');
    expect(opened.getMeta().name).toBe('新名');
    expect(ProjectRepository.open(projectDir)!.getMeta().name).toBe('新名');
  });

  it('create 支持嵌套目录', () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const nested = path.join(root, 'a', 'b', '项目');
    const repo = ProjectRepository.create(nested, '嵌套');
    expect(fs.existsSync(path.join(nested, 'project.json'))).toBe(true);
    expect(repo.getMeta().name).toBe('嵌套');
  });
});

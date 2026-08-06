/**
 * project-repository.ts — 项目布局与项目元数据（design doc §4.1）。
 *
 * <project>/
 *   project.json
 *   outline.json              （由 outline-repository 管理）
 *   nodes/                    （由 outline-repository 管理）
 *   conversation/             （由 conversation-repository 管理）
 *   attachments/              （由 attachment-repository 管理）
 *   world/                    （由 asset-repository 管理）
 *   visible_views/            （M5 使用）
 *   outputs/                  （M5 使用）
 *   snapshots/                （由 snapshot-repository 管理）
 */
import * as path from 'path';
import { ensureDir, readJsonFile, writeJsonFile } from '../file-store';
import { generateId } from './id';
import { emptyOutlineTree } from './outline-repository';

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_LAYOUT_DIRS = [
  'nodes',
  'conversation',
  'attachments',
  'world',
  'visible_views',
  'outputs',
  'snapshots',
] as const;

export class ProjectRepository {
  private constructor(
    private readonly projectDir: string,
    private readonly meta: ProjectMeta,
  ) {}

  /** 创建新项目：写入 project.json 并铺好目录布局与空大纲树。 */
  static create(projectDir: string, name: string): ProjectRepository {
    const now = new Date().toISOString();
    ensureDir(projectDir);
    const meta: ProjectMeta = {
      id: generateId('proj'),
      name,
      createdAt: now,
      updatedAt: now,
    };
    writeJsonFile(path.join(projectDir, 'project.json'), meta);
    const repo = new ProjectRepository(projectDir, meta);
    repo.ensureLayout();
    writeJsonFile(path.join(projectDir, 'outline.json'), emptyOutlineTree());
    return repo;
  }

  /** 打开已有项目；目录里没有 project.json 时返回 null。 */
  static open(projectDir: string): ProjectRepository | null {
    const meta = readJsonFile<ProjectMeta>(path.join(projectDir, 'project.json'));
    if (!meta) return null;
    const repo = new ProjectRepository(projectDir, meta);
    repo.ensureLayout();
    return repo;
  }

  get dir(): string {
    return this.projectDir;
  }

  getMeta(): ProjectMeta {
    return this.readMeta();
  }

  private readMeta(): ProjectMeta {
    return readJsonFile<ProjectMeta>(path.join(this.projectDir, 'project.json')) ?? this.meta;
  }

  rename(newName: string): void {
    const meta = this.readMeta();
    meta.name = newName;
    meta.updatedAt = new Date().toISOString();
    writeJsonFile(path.join(this.projectDir, 'project.json'), meta);
  }

  touch(): void {
    const meta = this.readMeta();
    meta.updatedAt = new Date().toISOString();
    writeJsonFile(path.join(this.projectDir, 'project.json'), meta);
  }

  /** 确保所有子目录存在（打开旧项目或目录被部分清理后调用）。 */
  ensureLayout(): void {
    for (const dir of PROJECT_LAYOUT_DIRS) {
      ensureDir(path.join(this.projectDir, dir));
    }
  }
}

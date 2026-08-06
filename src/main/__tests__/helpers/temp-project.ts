/**
 * test helpers — 临时目录与项目构造（storage 测试共用）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectRepository } from '../../storage/project-repository';

export function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `sw2-test-${randomSuffix()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}

/** 在临时目录创建一个真实项目，返回 projectDir 与仓库句柄。 */
export function makeProject(name = '测试项目'): {
  projectDir: string;
  repo: ProjectRepository;
} {
  const root = makeTempDir();
  const projectDir = path.join(root, 'proj');
  const repo = ProjectRepository.create(projectDir, name);
  return { projectDir, repo };
}

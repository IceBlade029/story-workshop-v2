/**
 * snapshot-repository.ts — 写入前快照与回滚（design doc §5.4、§9.1）。
 *
 * 可写任务运行前，把受影响文件（outline.json、节点文件、world/ 设定文件）
 * 复制到 snapshots/<runId>/（保留相对项目根目录的路径），并写 manifest.json。
 * 回滚 = 把快照目录里的文件按相对路径复制回项目。
 *
 * 保留策略延后决定（默认全保留，因项目文件很小）——M6 处理清理。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, fileExists } from '../file-store';
import { generateId } from './id';
import { sha256 } from './hash';

export interface SnapshotInfo {
  runId: string;
  /** 被快照（复制到快照目录）的文件（相对项目根目录的路径，使用 `/` 分隔） */
  files: string[];
  /** 快照覆盖的顶层目录 */
  dirs: string[];
  /** 快照时刻目录内已存在的全部文件（回滚时据此清理运行期间新建的孤儿文件） */
  preExistingFiles: string[];
  createdAt: string;
}

/** 快照覆盖的内容目录（这些目录里的孤儿文件在回滚时被清理）。 */
const SNAPSHOT_DIRS = ['nodes', 'world', 'visible_views', 'outputs'];

export class SnapshotRepository {
  constructor(private readonly projectDir: string) {}

  private snapshotDir(runId: string): string {
    return path.join(this.projectDir, 'snapshots', runId);
  }

  private manifestFilePath(runId: string): string {
    return path.join(this.snapshotDir(runId), 'manifest.json');
  }

  /**
   * 把绝对路径转为项目内相对路径（统一用 `/` 分隔，跨平台可移植）。
   * 项目目录外或绝对路径本身异常时返回 null。
   */
  private toPortableRelative(file: string): string | null {
    const relative = path.relative(this.projectDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  }

  /**
   * 为一批受影响文件创建快照。
   *
   * @param affectedFiles 绝对路径（必须位于项目目录内）；不存在的文件跳过。
   * @returns 快照信息（含相对路径清单，使用 `/` 分隔）
   */
  createSnapshot(runId: string, affectedFiles: string[]): SnapshotInfo {
    const targetDir = this.snapshotDir(runId);
    ensureDir(targetDir);
    const files: string[] = [];
    const dirs = new Set<string>();
    for (const file of affectedFiles) {
      if (!fileExists(file)) continue;
      const relative = this.toPortableRelative(file);
      if (!relative) continue; // 只快照项目目录内的文件
      const top = relative.includes('/') ? relative.split('/')[0] : null;
      if (top) dirs.add(top);
      const dest = path.join(targetDir, ...relative.split('/'));
      ensureDir(path.dirname(dest));
      fs.copyFileSync(file, dest);
      files.push(relative);
    }
    // 内容目录即使当前为空也纳入覆盖（运行期间可能新建文件）
    for (const d of SNAPSHOT_DIRS) {
      if (fs.existsSync(path.join(this.projectDir, d))) dirs.add(d);
    }
    // 记录快照时刻目录内已存在的全部文件（不在其中的 = 运行期间新建 → 回滚时删除）
    const preExistingFiles = this.scanFilesInDirs([...dirs]);
    const info: SnapshotInfo = {
      runId,
      files,
      dirs: [...dirs],
      preExistingFiles,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.manifestFilePath(runId), JSON.stringify(info, null, 2), 'utf-8');
    return info;
  }

  /** 扫描若干顶层目录（相对项目根）内的全部文件，返回 `/` 分隔的相对路径。 */
  private scanFilesInDirs(dirs: string[]): string[] {
    const out: string[] = [];
    for (const dir of dirs) {
      const fullDir = path.join(this.projectDir, dir);
      try {
        for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const sub = this.scanFilesInDirs([`${dir}/${entry.name}`]);
            out.push(...sub);
          } else {
            out.push(`${dir}/${entry.name}`);
          }
        }
      } catch {
        /* 目录不存在 */
      }
    }
    return out;
  }

  /**
   * 按 manifest 把快照文件复制回项目，并清理运行期间新建的孤儿文件，
   * 使快照覆盖的目录恢复为写前状态（完整状态回滚，§5.4）。
   *
   * @returns 被恢复（复制回来）的相对路径
   */
  restoreSnapshot(runId: string): string[] {
    const manifest = this.readManifest(runId);
    if (!manifest) throw new Error(`SNAPSHOT_NOT_FOUND: ${runId}`);
    const restored: string[] = [];
    for (const relative of manifest.files) {
      const src = path.join(this.snapshotDir(runId), ...relative.split('/'));
      if (!fileExists(src)) continue;
      const dest = path.join(this.projectDir, ...relative.split('/'));
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      restored.push(relative);
    }
    // 清理孤儿文件：快照覆盖的目录里、快照时刻不存在（= 运行期间新建）的文件
    for (const dir of manifest.dirs ?? []) {
      this.removeOrphanFiles(dir, manifest.preExistingFiles ?? []);
    }
    return restored;
  }

  /** 删除目录内未被 preExistingFiles 记录的文件。 */
  private removeOrphanFiles(dir: string, preExistingFiles: string[]): void {
    const fullDir = path.join(this.projectDir, dir);
    try {
      for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          this.removeOrphanFiles(`${dir}/${entry.name}`, preExistingFiles);
          continue;
        }
        const relative = `${dir}/${entry.name}`;
        if (!preExistingFiles.includes(relative)) {
          try { fs.unlinkSync(path.join(fullDir, entry.name)); } catch { /* best effort */ }
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }

  readManifest(runId: string): SnapshotInfo | null {
    try {
      if (!fileExists(this.manifestFilePath(runId))) return null;
      return JSON.parse(fs.readFileSync(this.manifestFilePath(runId), 'utf-8')) as SnapshotInfo;
    } catch {
      return null;
    }
  }

  hasSnapshot(runId: string): boolean {
    return this.readManifest(runId) !== null;
  }

  listSnapshots(): string[] {
    const dir = path.join(this.projectDir, 'snapshots');
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && this.hasSnapshot(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** 生成一个新 runId（供调用方在写前快照时使用）。 */
  newRunId(): string {
    return generateId('run');
  }

  deleteSnapshot(runId: string): void {
    try {
      fs.rmSync(this.snapshotDir(runId), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------- 版本历史

  /**
   * 节点版本历史（§5.5）：遍历快照，找出包含 nodes/<nodeId>.md 的
   * 快照（提交快照 = 版本历史的一页；运行快照恰好含节点文件也算一页）。
   */
  listNodeVersions(nodeId: string): Array<{ snapshotId: string; createdAt: string; hash: string }> {
    const out: Array<{ snapshotId: string; createdAt: string; hash: string }> = [];
    for (const snapshotId of this.listSnapshots()) {
      const file = path.join(this.snapshotDir(snapshotId), 'nodes', `${nodeId}.md`);
      if (!fileExists(file)) continue;
      const manifest = this.readManifest(snapshotId);
      const hash = sha256(fs.readFileSync(file, 'utf-8'));
      out.push({ snapshotId, createdAt: manifest?.createdAt ?? '', hash });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 读取某版本快照中的节点正式版内容；不存在返回 null。 */
  readNodeVersion(nodeId: string, snapshotId: string): string | null {
    const file = path.join(this.snapshotDir(snapshotId), 'nodes', `${nodeId}.md`);
    if (!fileExists(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  }

  // -------------------------------------------------------------- 保留策略

  /**
   * 快照保留策略（§12.1 决定）：保留全部 commit-* 快照（版本历史，§5.5），
   * 其余运行快照最多保留最近 maxRunSnapshots 个（默认 50），更旧的删除。
   * 项目文件很小，全保留也合理——此策略只是防止无限增长。
   */
  pruneRetention(maxRunSnapshots = 50): string[] {
    const snapshots = this.listSnapshots();
    const commits = snapshots.filter((s) => s.startsWith('commit-'));
    const runs = snapshots
      .filter((s) => !s.startsWith('commit-'))
      .sort((a, b) => (this.readManifest(a)?.createdAt ?? '').localeCompare(this.readManifest(b)?.createdAt ?? ''));
    const excess = runs.slice(0, Math.max(0, runs.length - maxRunSnapshots));
    for (const runId of excess) this.deleteSnapshot(runId);
    return excess;
  }
}

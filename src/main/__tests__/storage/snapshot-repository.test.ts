import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotRepository } from '../../storage/snapshot-repository';
import { OutlineRepository } from '../../storage/outline-repository';
import { AssetRepository } from '../../storage/asset-repository';
import { makeProject, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeSnapshot(): { snap: SnapshotRepository; projectDir: string } {
  const { projectDir } = makeProject();
  tempDirs.push(path.dirname(projectDir));
  return { snap: new SnapshotRepository(projectDir), projectDir };
}

describe('snapshot-repository', () => {
  it('createSnapshot 按相对路径复制受影响文件并写 manifest', () => {
    const { snap, projectDir } = makeSnapshot();
    const outline = new OutlineRepository(projectDir);
    outline.createNode('overview', { id: 'v1', type: 'volume', title: 'V1', children: [] });
    outline.writeDraft('v1', '草稿内容');
    const assets = new AssetRepository(projectDir);
    assets.createAsset('character', '林默', '角色卡内容');

    const runId = snap.newRunId();
    expect(runId).toMatch(/^run_/);
    const info = snap.createSnapshot(runId, [
      path.join(projectDir, 'outline.json'),
      path.join(projectDir, 'nodes', 'v1.draft.md'),
      path.join(projectDir, 'nodes', 'v1.md'), // 不存在，应被跳过
      path.join(projectDir, 'world', `${assets.listAssets()[0].id}.md`),
    ]);

    expect(info.files.sort()).toEqual([
      'nodes/v1.draft.md',
      'outline.json',
      `world/${assets.listAssets()[0].id}.md`,
    ]);
    expect(snap.readManifest(runId)?.files.sort()).toEqual(info.files.sort());
    expect(
      fs.readFileSync(path.join(projectDir, 'snapshots', runId, 'nodes', 'v1.draft.md'), 'utf-8'),
    ).toBe('草稿内容');
    expect(snap.hasSnapshot(runId)).toBe(true);
    expect(snap.listSnapshots()).toContain(runId);
  });

  it('createSnapshot 跳过项目目录外的文件', () => {
    const { snap, projectDir } = makeSnapshot();
    const outside = path.join(projectDir, '..', 'outside.txt');
    fs.writeFileSync(outside, '外部文件', 'utf-8');
    const info = snap.createSnapshot('run_out', [outside]);
    expect(info.files).toEqual([]);
  });

  it('restoreSnapshot 把快照内容复制回项目', () => {
    const { snap, projectDir } = makeSnapshot();
    const outline = new OutlineRepository(projectDir);
    outline.createNode('overview', { id: 'v1', type: 'volume', title: 'V1', children: [] });
    outline.writeDraft('v1', '原始草稿');

    const runId = snap.newRunId();
    snap.createSnapshot(runId, [path.join(projectDir, 'outline.json'), path.join(projectDir, 'nodes', 'v1.draft.md')]);

    // 写入被修改后回滚
    outline.writeDraft('v1', '被 AI 改坏的草稿');
    const restored = snap.restoreSnapshot(runId);
    expect(restored.sort()).toEqual(['nodes/v1.draft.md', 'outline.json']);
    expect(outline.readDraft('v1')).toBe('原始草稿');
  });

  it('restoreSnapshot 对不存在的 runId 抛错', () => {
    const { snap } = makeSnapshot();
    expect(() => snap.restoreSnapshot('run_ghost')).toThrow('SNAPSHOT_NOT_FOUND');
  });

  it('captureAfterState 冻结写后状态，并用全项目 hash 门禁检测后续冲突', () => {
    const { snap, projectDir } = makeSnapshot();
    const outline = new OutlineRepository(projectDir);
    outline.createNode('overview', { id: 'v1', type: 'volume', title: 'V1', children: [] });
    outline.writeDraft('v1', '写前');
    snap.createSnapshot('run_after', [path.join(projectDir, 'outline.json'), path.join(projectDir, 'nodes', 'v1.draft.md')]);

    outline.writeDraft('v1', '写后');
    snap.captureAfterState('run_after');
    expect(snap.readCapturedFile('run_after', 'after', 'nodes/v1.draft.md')).toBe('写后');
    expect(snap.matchesCurrentAfterState('run_after')).toBe(true);

    outline.writeDraft('v1', '后来手改');
    expect(snap.matchesCurrentAfterState('run_after')).toBe(false);
    expect(snap.readCapturedFile('run_after', 'after', 'nodes/v1.draft.md')).toBe('写后');
  });

  it('deleteSnapshot 删除快照目录', () => {
    const { snap } = makeSnapshot();
    snap.createSnapshot('run_del', []);
    expect(snap.hasSnapshot('run_del')).toBe(true);
    snap.deleteSnapshot('run_del');
    expect(snap.hasSnapshot('run_del')).toBe(false);
  });

  it('回滚清理运行期间新建的孤儿文件，保留目录内未被快照的既有文件', () => {
    const { snap, projectDir } = makeSnapshot();
    // 写前状态：world/ 有 index.json 与一个设定；nodes/ 为空
    const assets = new AssetRepository(projectDir);
    const existing = assets.createAsset('character', '林默', '原始');
    const indexBefore = fs.readFileSync(path.join(projectDir, 'world', 'index.json'), 'utf-8');

    // 只快照设定正文文件（模拟只声明受影响文件）
    const runId = snap.newRunId();
    snap.createSnapshot(runId, [path.join(projectDir, 'world', `${existing.id}.md`)]);

    // 运行期间：新建一个设定（孤儿文件）+ 更新已有设定 + 改 index
    const orphan = assets.createAsset('location', '青石镇', '新设定');
    assets.updateAsset(existing.id, { content: '被改坏' });

    const restored = snap.restoreSnapshot(runId);
    expect(restored).toEqual([`world/${existing.id}.md`]);
    // 既有设定恢复原文
    expect(assets.readAsset(existing.id)!.content).toBe('原始');
    // 运行期间新建的孤儿设定文件被删除（index 条目不受影响——index.json 未被快照）
    expect(fs.existsSync(path.join(projectDir, 'world', `${orphan.id}.md`))).toBe(false);
    // 未被快照的既有文件（index.json）保留（内容可能被运行期改动过，文件本身不删）
    expect(fs.existsSync(path.join(projectDir, 'world', 'index.json'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'world', 'index.json'), 'utf-8')).toBeTruthy();
    expect(indexBefore).toBeTruthy();
  });
});

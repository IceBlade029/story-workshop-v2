import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AssetRepository } from '../../storage/asset-repository';
import { sha256 } from '../../storage/hash';
import { makeProject, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeAssets(): { assets: AssetRepository; projectDir: string } {
  const { projectDir } = makeProject();
  tempDirs.push(path.dirname(projectDir));
  return { assets: new AssetRepository(projectDir), projectDir };
}

describe('asset-repository（设定空间）', () => {
  it('createAsset 写入正文与索引（含 hash、时间戳）', () => {
    const { assets, projectDir } = makeAssets();
    const a = assets.createAsset('character', '林默', '## 角色卡\n\n- 身份：凶手');
    expect(a.id).toMatch(/^ast_/);
    expect(a.hash).toBe(sha256('## 角色卡\n\n- 身份：凶手'));
    expect(fs.readFileSync(path.join(projectDir, 'world', `${a.id}.md`), 'utf-8')).toBe('## 角色卡\n\n- 身份：凶手');
    const index = JSON.parse(fs.readFileSync(path.join(projectDir, 'world', 'index.json'), 'utf-8'));
    expect(index).toHaveLength(1);
    expect(index[0].type).toBe('character');
    expect(index[0].createdAt).toBeTruthy();
    expect(index[0].updatedAt).toBeTruthy();
  });

  it('type 是自由字符串，不强制 schema（§3.6）', () => {
    const { assets } = makeAssets();
    const a = assets.createAsset('任意自定义类型', '灵感', '内容');
    expect(a.type).toBe('任意自定义类型');
    expect(assets.readAsset(a.id)?.type).toBe('任意自定义类型');
  });

  it('readAsset 合并索引与正文；缺失返回 null', () => {
    const { assets } = makeAssets();
    const a = assets.createAsset('misc', '灵感', '待定：戒指的来历');
    const read = assets.readAsset(a.id)!;
    expect(read.content).toBe('待定：戒指的来历');
    expect(read.title).toBe('灵感');
    expect(assets.readAsset('ghost')).toBeNull();
  });

  it('updateAsset 更新标题/类型/内容并刷新 hash', () => {
    const { assets } = makeAssets();
    const a = assets.createAsset('character', '林默', 'v1');
    const updated = assets.updateAsset(a.id, { title: '林默（主角）', content: 'v2' })!;
    expect(updated.title).toBe('林默（主角）');
    expect(updated.hash).toBe(sha256('v2'));
    expect(updated.updatedAt >= a.updatedAt).toBe(true);
    expect(assets.readAsset(a.id)!.content).toBe('v2');
  });

  it('updateAsset 对缺失 id 返回 null', () => {
    const { assets } = makeAssets();
    expect(assets.updateAsset('ghost', { content: 'x' })).toBeNull();
  });

  it('deleteAsset 移除索引与正文', () => {
    const { assets, projectDir } = makeAssets();
    const a = assets.createAsset('location', '青石镇', '内容');
    assets.deleteAsset(a.id);
    expect(assets.listAssets()).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, 'world', `${a.id}.md`))).toBe(false);
  });

  it('listAssets 返回全部设定', () => {
    const { assets } = makeAssets();
    assets.createAsset('character', '林默', '角色');
    assets.createAsset('timeline', '编年史', '事件');
    expect(assets.listAssets().map((a) => a.type)).toEqual(['character', 'timeline']);
  });
});

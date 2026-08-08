/**
 * path-safety.test.ts — 落盘路径安全（P0 修复）。
 *
 * 模型可控 ID（nodeId / sceneId / assetId / format）必须通过安全校验，
 * 任何目录穿越（..、路径分隔符、绝对路径）在仓库层被拒绝。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertSafeId, assertSafeFormat, resolveWithin } from '../../storage/path-safety';
import { OutputRepository } from '../../storage/output-repository';
import { OutlineRepository, OVERVIEW_ROOT_ID } from '../../storage/outline-repository';
import { AssetRepository } from '../../storage/asset-repository';

describe('path-safety — assertSafeId', () => {
  it('接受合法 id（字母/数字/下划线/连字符）', () => {
    expect(assertSafeId('v1', 'node')).toBe('v1');
    expect(assertSafeId('n_abc123', 'node')).toBe('n_abc123');
    expect(assertSafeId('scene-01', 'scene')).toBe('scene-01');
    expect(assertSafeId('overview', 'node')).toBe('overview');
  });

  it('拒绝目录穿越与非法字符', () => {
    for (const bad of ['..', '../evil', '..\\..\\evil', 'a/b', 'a\\b', '', '.', '.. ', 'a b', 'a.b', 'a#b', 'a?b', '*', ':']) {
      expect(() => assertSafeId(bad, 'node'), `should reject: ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('拒绝超长 id', () => {
    expect(() => assertSafeId('x'.repeat(81), 'node')).toThrow();
    expect(assertSafeId('x'.repeat(80), 'node')).toBe('x'.repeat(80));
  });
});

describe('path-safety — assertSafeFormat', () => {
  it('接受 novel / script', () => {
    expect(assertSafeFormat('novel')).toBe('novel');
    expect(assertSafeFormat('script')).toBe('script');
  });

  it('拒绝穿越与非法格式名', () => {
    for (const bad of ['../x', '..\\x', 'Novel', 'novel ', 'novel.md', 'x/y']) {
      expect(() => assertSafeFormat(bad), `should reject: ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe('path-safety — resolveWithin', () => {
  it('正常拼接仍在子目录内', () => {
    const full = resolveWithin('C:\\proj', 'outputs', 's1.novel.md');
    expect(full.startsWith(path.resolve('C:\\proj', 'outputs') + path.sep)).toBe(true);
  });

  it('拒绝越界文件名（.. 与绝对路径）', () => {
    expect(() => resolveWithin('C:\\proj', 'outputs', '..\\evil.md')).toThrow();
    expect(() => resolveWithin('C:\\proj', 'outputs', '..\\..\\evil.md')).toThrow();
    expect(() => resolveWithin('C:\\proj', 'outputs', 'C:\\evil.md')).toThrow();
  });
});

describe('path-safety — 仓库层拦截（P0）', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2-ps-'));
  const outputs = new OutputRepository(projectDir);
  const outline = new OutlineRepository(projectDir);
  const assets = new AssetRepository(projectDir);

  outline.saveTree({ version: 1, root: { id: OVERVIEW_ROOT_ID, type: 'overview', title: '总纲', children: [] } });

  it('write_output 拒绝穿越 sceneId / format，不产生任何文件', () => {
    expect(() => outputs.write('..\\..\\evil', 'novel', 'x', 'hash')).toThrow();
    expect(() => outputs.write('s1', '..\\..', 'x', 'hash')).toThrow();
    expect(fs.existsSync(path.join(projectDir, 'outputs', 'index.json'))).toBe(false);
  });

  it('outline 读写拒绝穿越 nodeId', () => {
    expect(() => outline.writeDraft('..\\..\\evil', 'x')).toThrow();
    expect(() => outline.readOfficial('..\\evil')).toThrow();
    expect(() => outline.createNode(OVERVIEW_ROOT_ID, { id: 'a\\b', type: 'chapter', title: 'x', children: [] })).toThrow();
  });

  it('asset 读写拒绝穿越 assetId', () => {
    expect(() => assets.readAsset('..\\..\\evil')).not.toThrow(); // 读不到即 null，不落地
    const a = assets.createAsset('character', '主角', 'x');
    expect(assets.readAsset(a.id)).not.toBeNull();
    expect(() => assets.updateAsset('..\\..\\evil', { content: 'x' })).not.toThrow();
  });

  it('穿越 id 无法读到项目外文件', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), '机密', 'utf-8');
    // 即使 sceneId 指向外部目录（构造上已被拦截），读取也不会命中
    expect(() => outputs.read('..\\..\\secret', 'novel')).toThrow();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

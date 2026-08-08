/**
 * app-service-output.test.ts — 可靠写作闭环（ux-review §6.8）：
 * 手工保存（快照成版）、正文版本历史、整书导出。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import { AppService } from '../app-service';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import { makeTempDir, removeDir } from './helpers/temp-project';

// 与机器上的真实凭据库解耦
vi.mock('../api-key-store', () => ({
  saveApiKey: vi.fn(),
  hasApiKey: () => false,
  loadApiKeyEntry: () => null,
}));

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeService(script: ScriptedTurn[] = []): AppService {
  const service = new AppService(() => new ScriptedModelAdapter(script));
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), '输出项目');
  return service;
}

function setupScene(service: AppService, id: string, title: string): void {
  service.workspace.outline.createNode('overview', { id, type: 'scene', title, children: [] });
}

describe('手工保存正文（ux-review §6.8）', () => {
  it('saveOutput：落盘 + 写入前快照 + 版本历史（含 HEAD）；回滚恢复旧内容', () => {
    const service = makeService();
    setupScene(service, 's1', '第一场');

    service.saveOutput('s1', 'novel', '第一版');
    expect(service.workspace.outputs.read('s1', 'novel')).toBe('第一版');

    service.saveOutput('s1', 'novel', '第二版');
    expect(service.workspace.outputs.read('s1', 'novel')).toBe('第二版');

    // 版本：HEAD（第二版）+ 两次写前快照（新→旧排序）
    const versions = service.listOutputVersions('s1', 'novel');
    expect(versions).toHaveLength(3);
    expect(versions[0].snapshotId).toBe('current');
    expect(service.readOutputVersion('s1', 'novel', 'current')).toBe('第二版');
    expect(service.readOutputVersion('s1', 'novel', versions[1].snapshotId)).toBe('第一版');

    // 回滚第一版快照 → 正文恢复为第一版（含输出索引）
    service.rollbackRun(versions[1].snapshotId);
    expect(service.workspace.outputs.read('s1', 'novel')).toBe('第一版');
  });

  it('saveOutput：非场景节点拒绝', () => {
    const service = makeService();
    service.workspace.outline.createNode('overview', { id: 'v1', type: 'volume', title: '第一卷', children: [] });
    expect(() => service.saveOutput('v1', 'novel', 'x')).toThrow('NOT_SCENE_NODE');
    expect(() => service.saveOutput('ghost', 'novel', 'x')).toThrow('NODE_NOT_FOUND');
  });

  it('detail_fill 生成的正文进版本历史（复用 run 快照）', async () => {
    const script: ScriptedTurn[] = [
      { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'read_visible_view', arguments: { sceneId: 's1' } }], usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'tool_calls', toolCalls: [{ id: 'c2', name: 'write_output', arguments: { sceneId: 's1', format: 'novel', content: '生成正文' } }], usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'final', answer: '完成', usage: { inputTokens: 15, outputTokens: 3 } },
    ];
    const service = makeService(script);
    setupScene(service, 's1', '第一场');
    service.workspace.visibleViews.write({
      sceneId: 's1', content: '视图内容', sourceHash: 'h', userEdited: false, needsRegeneration: false, generatedAt: 't',
    });

    const result = await service.runDetailFill('s1', 'novel');
    expect(result.error).toBeUndefined();
    expect(service.workspace.outputs.read('s1', 'novel')).toBe('生成正文');

    // 生成后：HEAD = 生成正文（新建首版没有写前快照，由 HEAD 兜底）
    let versions = service.listOutputVersions('s1', 'novel');
    expect(versions).toHaveLength(1);
    expect(versions[0].snapshotId).toBe('current');
    expect(service.readOutputVersion('s1', 'novel', 'current')).toBe('生成正文');

    // 手工保存 → 生成版进写前快照 + 新 HEAD
    service.saveOutput('s1', 'novel', '手工修改版');
    versions = service.listOutputVersions('s1', 'novel');
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshotId).toBe('current');
    expect(service.readOutputVersion('s1', 'novel', versions[1].snapshotId)).toBe('生成正文');

    // 接受改写 → 改写前版本进快照（revise-* 写前快照）
    service.applyRevise('s1', 'novel', 0, 4, '改写');
    versions = service.listOutputVersions('s1', 'novel');
    expect(versions).toHaveLength(3);
    expect(service.readOutputVersion('s1', 'novel', versions[1].snapshotId)).toBe('手工修改版');
  });

  it('版本历史与节点历史互不混淆（只列该场景该格式；HEAD 参与计数）', () => {
    const service = makeService();
    setupScene(service, 's1', '第一场');
    setupScene(service, 's2', '第二场');
    service.saveOutput('s1', 'novel', 'A');
    service.saveOutput('s1', 'script', 'A剧本');
    service.saveOutput('s2', 'novel', 'B');
    expect(service.listOutputVersions('s1', 'novel')).toHaveLength(2); // 快照 + HEAD
    expect(service.listOutputVersions('s1', 'script')).toHaveLength(2);
    expect(service.listOutputVersions('s2', 'novel')).toHaveLength(2);
    expect(service.listOutputVersions('s2', 'script')).toHaveLength(0); // 从未生成
  });
});

describe('整书导出（§6.7）', () => {
  function makeBook(): AppService {
    const service = makeService();
    service.workspace.outline.createNode('overview', { id: 'v1', type: 'volume', title: '第一卷', children: [] });
    service.workspace.outline.createNode('v1', { id: 'c1', type: 'chapter', title: '第一章', hidden: true, children: [] });
    service.workspace.outline.createNode('c1', { id: 's1', type: 'scene', title: '场景一', children: [] });
    service.workspace.outline.createNode('c1', { id: 's2', type: 'scene', title: '场景二', children: [] });
    service.workspace.outline.createNode('overview', { id: 's3', type: 'scene', title: '尾声', children: [] });
    service.saveOutput('s1', 'novel', '正文一');
    service.saveOutput('s3', 'novel', '正文三');
    return service;
  }

  it('按大纲顺序合并；含标题选项；缺失场景进 missing 不阻断', () => {
    const service = makeBook();
    const r = service.exportBook('novel', { includeTitles: true });
    expect(r.content).toContain('# 第一卷');
    expect(r.content).toContain('## 第一章'); // 隐藏中间层级也输出标题（与左栏一致）
    expect(r.content).toContain('# 场景一');
    expect(r.content).toContain('正文一');
    expect(r.content).toContain('# 尾声');
    expect(r.content).toContain('正文三');
    expect(r.content).not.toContain('场景二');
    expect(r.missing).toEqual([{ nodeId: 's2', title: '场景二' }]);

    const noTitle = service.exportBook('novel', { includeTitles: false });
    expect(noTitle.content).not.toContain('第一卷');
    expect(noTitle.content).toContain('正文一');
    expect(noTitle.content).toContain('正文三');
    expect(noTitle.missing).toHaveLength(1);
  });

  it('格式不合法拒绝；空项目导出返回空内容', () => {
    const service = makeBook();
    expect(() => service.exportBook('..\\evil', { includeTitles: true })).toThrow('INVALID_FORMAT');
    const empty = makeService();
    const r = empty.exportBook('novel', { includeTitles: true });
    expect(r.content).toBe('');
    expect(r.missing).toEqual([]);
  });
});

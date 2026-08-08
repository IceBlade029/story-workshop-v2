/**
 * app-service-search.test.ts — 全局搜索（§6.9）与项目重命名（§6.10）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import { AppService } from '../app-service';
import { ScriptedModelAdapter } from '../agent-runtime/scripted-model-adapter';
import { makeTempDir, removeDir } from './helpers/temp-project';

vi.mock('../api-key-store', () => ({
  saveApiKey: vi.fn(),
  hasApiKey: () => false,
  loadApiKeyEntry: () => null,
}));

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeService(): AppService {
  const service = new AppService(() => new ScriptedModelAdapter());
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), '搜索项目');
  return service;
}

function setupScene(service: AppService, id: string, title: string): void {
  service.workspace.outline.createNode('overview', { id, type: 'scene', title, children: [] });
}

describe('全局搜索（§6.9）', () => {
  it('空查询返回空；大小写不敏感', () => {
    const service = makeService();
    expect(service.globalSearch('  ')).toEqual([]);
    setupScene(service, 's1', '天桥决斗');
    expect(service.globalSearch('天桥').some((r) => r.kind === 'node' && r.title === '天桥决斗')).toBe(true);
  });

  it('覆盖全部数据源并按 kind 分组', () => {
    const service = makeService();
    // 大纲：标题命中
    service.workspace.outline.createNode('overview', { id: 'v1', type: 'volume', title: '第一卷', children: [] });
    // 节点：草稿命中
    setupScene(service, 's1', '第一场');
    service.workspace.outline.writeDraft('s1', '陈默在码头等林静。');
    // 设定
    service.workspace.assets.createAsset('character', '陈默', '常在码头与人接头，有秘密。');
    // 对话（含会话归属）
    service.workspace.conversation.createSession('码头之约');
    service.workspace.conversation.appendMessage({ id: 'm1', role: 'user', content: '码头的秘密是什么？', timestamp: 't' });
    service.workspace.conversation.appendMessage({ id: 'm2', role: 'ai', content: '秘密藏在码头。', timestamp: 't', parentId: 'm1' });
    // 附件 + 引用消息
    const att = service.workspace.attachments.createAttachment('旧大纲.md', '码头的设定文档', 'uploaded');
    service.workspace.conversation.appendMessage({
      id: 'm3', role: 'user', content: '（附件：旧大纲.md）', timestamp: 't', parentId: 'm2',
      refs: { attachmentIds: [att.id] },
    });
    // 正文
    service.saveOutput('s1', 'novel', '码头夜色浓重。');
    // 可见视图
    service.workspace.visibleViews.write({
      sceneId: 's1', content: '码头：两人约定见面。', sourceHash: 'h', userEdited: false, needsRegeneration: false, generatedAt: 't',
    });

    const results = service.globalSearch('码头');
    const kinds = results.map((r) => r.kind);
    expect(kinds).toContain('node');        // 草稿命中 s1
    expect(kinds).toContain('asset');       // 设定标题/正文
    expect(kinds).toContain('conversation'); // 消息 m1/m2/m3
    expect(kinds).toContain('attachment');  // 附件正文
    expect(kinds).toContain('output');      // 生成正文
    expect(kinds).toContain('visible_view'); // 可见视图

    const outputHit = results.find((r) => r.kind === 'output');
    expect(outputHit).toBeDefined();
    expect(outputHit!.title).toContain('（novel）');
    expect(outputHit!.meta).toBe('novel');

    const attHit = results.find((r) => r.kind === 'attachment');
    expect(attHit!.meta).toBe(`msg:m3`); // 引用消息定位

    const convHit = results.find((r) => r.kind === 'conversation');
    expect(convHit!.meta).toBe('码头之约'); // 会话归属
  });

  it('每类结果上限与空命中', () => {
    const service = makeService();
    expect(service.globalSearch('不存在的内容xyz')).toEqual([]);
    for (let i = 0; i < 30; i++) {
      service.workspace.outline.createNode('overview', { id: `n${i}`, type: 'chapter', title: `同名词条${i}`, children: [] });
    }
    expect(service.globalSearch('同名词条').length).toBeLessThanOrEqual(20);
  });
});

describe('项目重命名（§6.10）', () => {
  it('更新 project.json 名称并反映到状态', () => {
    const service = makeService();
    const dir = service.dir;
    expect(service.getState().name).toBe('搜索项目');
    service.renameProject(dir, '新名称');
    expect(service.getState().name).toBe('新名称');
    const fs = require('fs') as typeof import('fs');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf-8')) as { name: string };
    expect(meta.name).toBe('新名称');
  });

  it('空名拒绝；非当前项目拒绝', () => {
    const service = makeService();
    expect(() => service.renameProject(service.dir, '  ')).toThrow('EMPTY_PROJECT_NAME');
    expect(() => service.renameProject('/other/proj', 'X')).toThrow('NO_PROJECT_OPEN');
  });
});

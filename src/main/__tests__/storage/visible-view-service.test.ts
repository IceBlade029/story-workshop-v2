/**
 * visible-view-service.test.ts — 可见视图生成与新鲜度（§6.3、§6.4、§4.3）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'path';
import { ProjectWorkspace } from '../../storage/workspace';
import { VisibleViewService } from '../../storage/visible-view-service';
import { sha256 } from '../../storage/hash';
import { makeProject, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeService(): { ws: ProjectWorkspace; service: VisibleViewService } {
  const { projectDir } = makeProject();
  tempDirs.push(projectDir);
  const ws = ProjectWorkspace.open(projectDir)!;
  return { ws, service: new VisibleViewService(ws.outline, ws.visibleViews) };
}

function addScene(ws: ProjectWorkspace, id: string): void {
  ws.outline.createNode('overview', { id, type: 'scene', title: `场景 ${id}`, children: [] });
}

const DRAFT_WITH_MARKER = '陈默（{{暂不明示：陈默是凶手}}）约林静见面。\n两人对峙。';

describe('可见视图生成（确定性，无模型参与）', () => {
  it('从草稿生成：整段机械移除标记，记录 sourceHash', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);

    const view = service.generate('s1');
    expect(view.content).toBe('陈默（）约林静见面。\n两人对峙。');
    expect(view.content).not.toContain('暂不明示');
    expect(view.sourceHash).toBe(sha256(DRAFT_WITH_MARKER));
    expect(view.userEdited).toBe(false);
    expect(view.needsRegeneration).toBe(false);
    expect(view.generatedAt).toBeTruthy();

    // 落盘 + meta 镜像
    const fromDisk = ws.visibleViews.read('s1')!;
    expect(fromDisk.content).toBe(view.content);
    expect(ws.outline.readMeta('s1').visibleView?.needsRegeneration).toBe(false);
  });

  it('正式版优先：有正式版时从正式版生成', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', '草稿版');
    ws.outline.writeOfficial('s1', '正式版{{暂不明示：秘密}}');

    const view = service.generate('s1');
    expect(view.content).toBe('正式版');
    expect(view.sourceHash).toBe(sha256('正式版{{暂不明示：秘密}}'));
  });

  it('非场景节点 / 无细纲内容：抛错', () => {
    const { ws, service } = makeService();
    ws.outline.createNode('overview', { id: 'v1', type: 'volume', title: '卷', children: [] });
    expect(() => service.generate('v1')).toThrow('NOT_SCENE_NODE');
    addScene(ws, 's1');
    expect(() => service.generate('s1')).toThrow('NO_SCENE_OUTLINE');
  });
});

describe('手改与覆盖保护（§6.4）', () => {
  it('saveUserEdit：置位 userEdited，清除失效标记', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');

    const view = service.saveUserEdit('s1', '手改后的视图');
    expect(view.userEdited).toBe(true);
    expect(view.needsRegeneration).toBe(false);
    expect(ws.visibleViews.read('s1')!.content).toBe('手改后的视图');
    expect(ws.outline.readMeta('s1').visibleView?.userEdited).toBe(true);
  });
});

describe('细纲变更后的新鲜度（§4.3 全 hash 驱动）', () => {
  it('未手改：细纲变更 → 自动重新生成', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    expect(ws.visibleViews.read('s1')!.content).toBe('陈默（）约林静见面。\n两人对峙。');

    // 细纲变更（新增标记）
    ws.outline.writeDraft('s1', '陈默（{{暂不明示：陈默是凶手}}）约林静见面。\n两人对峙。\n{{暂不明示：陈默早有准备}}');
    service.syncStale();
    const view = ws.visibleViews.read('s1')!;
    expect(view.content).toBe('陈默（）约林静见面。\n两人对峙。\n');
    expect(view.needsRegeneration).toBe(false);
    expect(view.userEdited).toBe(false);
  });

  it('手改过：细纲变更 → 内容受保护，置 needsRegeneration', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    service.saveUserEdit('s1', '作者手改：加一段留白');

    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER + '\n新增内容');
    service.syncStale();
    const view = ws.visibleViews.read('s1')!;
    expect(view.content).toBe('作者手改：加一段留白'); // 不静默覆盖
    expect(view.needsRegeneration).toBe(true);
    expect(ws.outline.readMeta('s1').visibleView?.needsRegeneration).toBe(true);
  });

  it('手改后细纲未再变更：不置失效', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    service.saveUserEdit('s1', '手改内容');
    service.syncStale();
    expect(ws.visibleViews.read('s1')!.needsRegeneration).toBe(false);
  });

  it('重新生成（显式）：覆盖手改并复位标记（§6.4 作者确认后）', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    service.saveUserEdit('s1', '手改');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER + '\n新段落{{暂不明示：新秘密}}');
    service.syncStale();
    expect(ws.visibleViews.read('s1')!.needsRegeneration).toBe(true);

    const view = service.generate('s1');
    expect(view.userEdited).toBe(false);
    expect(view.needsRegeneration).toBe(false);
    expect(view.content).toContain('新段落');
    expect(view.content).not.toContain('新秘密');
  });

  it('细纲内容被清空：不生成空视图，置失效', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    ws.outline.writeDraft('s1', '');
    service.syncStale();
    const view = ws.visibleViews.read('s1')!;
    expect(view.needsRegeneration).toBe(true);
    expect(view.content).toBe('陈默（）约林静见面。\n两人对峙。'); // 内容保持
  });

  it('无视图 / 内容未变更：syncStale 无副作用', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    service.syncStale(); // 内容没变
    expect(ws.visibleViews.read('s1')!.needsRegeneration).toBe(false);

    addScene(ws, 's2'); // 无视图
    service.syncStale();
    expect(ws.visibleViews.read('s2')).toBeNull();
  });

  it('提交正式版（内容相同）不触发重新生成', () => {
    const { ws, service } = makeService();
    addScene(ws, 's1');
    ws.outline.writeDraft('s1', DRAFT_WITH_MARKER);
    service.generate('s1');
    const before = ws.visibleViews.read('s1')!.generatedAt;
    ws.outline.writeOfficial('s1', DRAFT_WITH_MARKER);
    service.syncStale();
    expect(ws.visibleViews.read('s1')!.sourceHash).toBe(sha256(DRAFT_WITH_MARKER));
    expect(ws.visibleViews.read('s1')!.generatedAt).toBe(before);
    expect(ws.visibleViews.read('s1')!.needsRegeneration).toBe(false);
  });

  it('listSceneIds 只返回场景节点', () => {
    const { ws, service } = makeService();
    ws.outline.createNode('overview', { id: 'v1', type: 'volume', title: '卷', children: [] });
    addScene(ws, 's1');
    ws.outline.createNode('v1', { id: 'c1', type: 'chapter', title: '章', children: [] });
    ws.outline.createNode('c1', { id: 's2', type: 'scene', title: '场景', children: [] });
    expect(service.listSceneIds()).toEqual(['s2', 's1']);
  });
});

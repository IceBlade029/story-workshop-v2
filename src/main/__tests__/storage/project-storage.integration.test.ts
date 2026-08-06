import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectRepository } from '../../storage/project-repository';
import { OutlineRepository } from '../../storage/outline-repository';
import { ConversationRepository } from '../../storage/conversation-repository';
import { AttachmentRepository } from '../../storage/attachment-repository';
import { AssetRepository } from '../../storage/asset-repository';
import { SnapshotRepository } from '../../storage/snapshot-repository';
import { makeProject, removeDir } from '../helpers/temp-project';
import type { ChatMessage } from '../../../shared/types';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

/**
 * 集成：入口 A 的存储侧路径 —— 讨论 → 整理写入草稿/设定 → 快照 → 回滚。
 * （design doc §5.2 入口 A；M3 之前用手工仓库调用模拟整理任务）
 */
describe('storage 集成 — 讨论后整理（入口 A 存储侧）', () => {
  it('完整流：消息日志 → 整理光标 → 大纲草稿与设定 → 快照 → 回滚', () => {
    const { projectDir } = makeProject('我的故事');
    tempDirs.push(path.dirname(projectDir));

    const outline = new OutlineRepository(projectDir);
    const conv = new ConversationRepository(projectDir);
    const mats = new AttachmentRepository(projectDir);
    const assets = new AssetRepository(projectDir);
    const snap = new SnapshotRepository(projectDir);

    // 1. 讨论消息进入追加式日志
    const userMsg: ChatMessage = { id: 'msg_1', role: 'user', content: '主角是个侦探，隐藏身份是凶手。', timestamp: 't1' };
    const aiMsg: ChatMessage = { id: 'msg_2', role: 'ai', content: '可以，我记下了。', timestamp: 't2', runId: 'run_x' };
    conv.appendMessage(userMsg);
    conv.appendMessage(aiMsg);

    // 2. 整理任务：快照受影响文件（此时无改动）
    const runId = snap.newRunId();
    snap.createSnapshot(runId, [path.join(projectDir, 'outline.json')]);

    // 3. 整理写入：新大纲节点（AI 新增标记）+ 新设定
    outline.createNode('overview', { id: 'v1', type: 'volume', title: '第一卷', children: [] });
    outline.writeDraft('v1', '待定：侦探主角的登场方式');
    const asset = assets.createAsset('character', '侦探', '林默，表面是侦探，实际是凶手');

    // 4. 任务成功后推进整理光标
    conv.setOrganizeCursor('msg_2');
    expect(conv.readUnorganizedMessages()).toEqual([]);

    // 5. AI 新增标记与草稿 hash 可见
    expect(outline.findNode('v1')?.aiCreated).toBeUndefined();
    expect(outline.readMeta('v1').draftHash).toBeTruthy();
    expect(assets.readAsset(asset.id)?.hash).toBeTruthy();

    // 6. 先快照再乱改，验证回滚（模拟第二次运行前的快照）
    const run2 = snap.newRunId();
    snap.createSnapshot(run2, [
      path.join(projectDir, 'outline.json'),
      path.join(projectDir, 'nodes', 'v1.draft.md'),
      path.join(projectDir, 'world', `${asset.id}.md`),
    ]);
    outline.writeDraft('v1', '被 AI 改坏');
    assets.updateAsset(asset.id, { content: '被 AI 改坏' });
    outline.renameNode('v1', '改坏标题');

    snap.restoreSnapshot(run2);
    expect(outline.readDraft('v1')).toBe('待定：侦探主角的登场方式');
    expect(outline.findNode('v1')?.title).toBe('第一卷');
    expect(assets.readAsset(asset.id)?.content).toBe('林默，表面是侦探，实际是凶手');

    // 7. 日志保持追加式：恢复后消息仍在且未被改写
    expect(conv.readMessages().map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
    expect(conv.getOrganizeCursor()).toBe('msg_2');

    // 8. 项目可重新打开，数据完好
    const reopened = ProjectRepository.open(projectDir)!;
    expect(reopened.getMeta().name).toBe('我的故事');
  });

  it('材料引用不存正文：仅 materialId 进入聊天消息', () => {
    const { projectDir } = makeProject();
    tempDirs.push(path.dirname(projectDir));
    const mats = new AttachmentRepository(projectDir);
    const conv = new ConversationRepository(projectDir);

    const m = mats.createAttachment('旧大纲.txt', '整篇超长正文……', 'pasted');
    conv.appendMessage({
      id: 'msg_1',
      role: 'user',
      content: '帮我结构化这份大纲',
      timestamp: 't1',
      refs: { attachmentIds: [m.id] },
    });

    const stored = conv.getMessage('msg_1')!;
    expect(stored.refs?.attachmentIds).toEqual([m.id]);
    expect(JSON.stringify(stored)).not.toContain('整篇超长正文');
  });

  it('材料被外部修改后 recomputeHash 与索引 hash 不一致（新鲜度驱动）', () => {
    const { projectDir } = makeProject();
    tempDirs.push(path.dirname(projectDir));
    const mats = new AttachmentRepository(projectDir);
    const m = mats.createAttachment('大纲.docx', 'v1', 'uploaded');
    expect(mats.recomputeHash(m.id)).toBe(m.hash);
    fs.writeFileSync(
      path.join(projectDir, 'attachments', `${m.id}.md`),
      '被外部修改的内容',
      'utf-8',
    );
    const modified = mats.recomputeHash(m.id)!;
    expect(modified).not.toBe(m.hash);
  });
});

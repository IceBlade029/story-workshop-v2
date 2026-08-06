import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AttachmentRepository } from '../../storage/attachment-repository';
import { sha256 } from '../../storage/hash';
import { makeProject, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeAttachments(): { mats: AttachmentRepository; projectDir: string } {
  const { projectDir } = makeProject();
  tempDirs.push(path.dirname(projectDir));
  return { mats: new AttachmentRepository(projectDir), projectDir };
}

describe('attachment-repository', () => {
  it('createAttachment 写入正文文件与索引条目', () => {
    const { mats, projectDir } = makeAttachments();
    const m = mats.createAttachment('旧大纲.txt', '# 第一章\n内容', 'pasted');
    expect(m.id).toMatch(/^att_/);
    expect(m.name).toBe('旧大纲.txt');
    expect(m.source).toBe('pasted');
    expect(m.hash).toBe(sha256('# 第一章\n内容'));
    expect(fs.readFileSync(path.join(projectDir, 'attachments', `${m.id}.md`), 'utf-8')).toBe('# 第一章\n内容');
    const index = JSON.parse(fs.readFileSync(path.join(projectDir, 'attachments', 'index.json'), 'utf-8'));
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(m.id);
    expect(index[0].mtime).toBeTruthy();
    expect(index[0].createdAt).toBeTruthy();
  });

  it('readAttachment 返回 meta + 正文；缺失返回 null', () => {
    const { mats } = makeAttachments();
    const m = mats.createAttachment('材料', '正文', 'uploaded');
    const read = mats.readAttachment(m.id)!;
    expect(read.meta.name).toBe('材料');
    expect(read.content).toBe('正文');
    expect(mats.readAttachment('ghost')).toBeNull();
    expect(mats.readAttachmentMeta('ghost')).toBeNull();
  });

  it('updateAttachment 更新内容：hash 与 mtime 变化，可带新名称', () => {
    const { mats } = makeAttachments();
    const m = mats.createAttachment('旧名', 'v1', 'pasted');
    const updated = mats.updateAttachment(m.id, 'v2', '新名')!;
    expect(updated.hash).toBe(sha256('v2'));
    expect(updated.hash).not.toBe(m.hash);
    expect(updated.name).toBe('新名');
    expect(updated.mtime >= m.mtime).toBe(true);
    expect(mats.readAttachment(m.id)!.content).toBe('v2');
  });

  it('updateAttachment 对缺失 id 返回 null', () => {
    const { mats } = makeAttachments();
    expect(mats.updateAttachment('ghost', 'x')).toBeNull();
  });

  it('recomputeHash 检测外部修改（§4.3 新鲜度比对）', () => {
    const { mats, projectDir } = makeAttachments();
    const m = mats.createAttachment('材料', '原始', 'workspace');
    expect(mats.recomputeHash(m.id)).toBe(sha256('原始'));
    fs.writeFileSync(path.join(projectDir, 'attachments', `${m.id}.md`), '被外部修改', 'utf-8');
    expect(mats.recomputeHash(m.id)).toBe(sha256('被外部修改'));
    expect(mats.recomputeHash('ghost')).toBeNull();
  });

  it('deleteAttachment 移除索引条目与正文文件', () => {
    const { mats, projectDir } = makeAttachments();
    const a = mats.createAttachment('A', 'a', 'pasted');
    const b = mats.createAttachment('B', 'b', 'pasted');
    mats.deleteAttachment(a.id);
    expect(mats.listAttachments().map((m) => m.id)).toEqual([b.id]);
    expect(fs.existsSync(path.join(projectDir, 'attachments', `${a.id}.md`))).toBe(false);
  });

  it('listAttachments 返回全部材料', () => {
    const { mats } = makeAttachments();
    expect(mats.listAttachments()).toEqual([]);
    mats.createAttachment('A', 'a', 'pasted');
    mats.createAttachment('B', 'b', 'uploaded');
    expect(mats.listAttachments().map((m) => m.name)).toEqual(['A', 'B']);
  });
});

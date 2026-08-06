/**
 * DiffView.tsx — 变更摘要的文件级行 diff（§5.4）。
 *
 * 输入为 run:diff 返回的 { path, before, after }；用 jsdiff 做行级 diff，
 * 渲染增/删/上下文三态行。新文件（before=null）折叠为「新增文件」。
 */
import React from 'react';
import { diffLines } from 'diff';
import type { FileDiff } from '../../../shared/ipc-types';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  beforeLn: number | null;
  afterLn: number | null;
  text: string;
}

function computeLines(before: string | null, after: string | null): DiffLine[] {
  const parts = diffLines(before ?? '', after ?? '');
  const out: DiffLine[] = [];
  let beforeLn = 0;
  let afterLn = 0;
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.added) {
      for (const line of lines) {
        afterLn++;
        out.push({ kind: 'add', beforeLn: null, afterLn, text: line });
      }
    } else if (part.removed) {
      for (const line of lines) {
        beforeLn++;
        out.push({ kind: 'del', beforeLn, afterLn: null, text: line });
      }
    } else {
      for (const line of lines) {
        beforeLn++;
        afterLn++;
        out.push({ kind: 'ctx', beforeLn, afterLn, text: line });
      }
    }
  }
  return out;
}

function fileTag(diff: FileDiff): { label: string; cls: string } {
  if (diff.before === null) return { label: '新增', cls: 'diff-tag-added' };
  if (diff.after === null) return { label: '删除', cls: 'diff-tag-removed' };
  return { label: '修改', cls: 'diff-tag-modified' };
}

export function DiffView({ diffs }: { diffs: FileDiff[] }): React.ReactElement {
  if (diffs.length === 0) {
    return <div className="diff-empty">没有文件级变化（只有结构操作）。</div>;
  }
  return (
    <div className="editor">
      {diffs.map((diff) => {
        const tag = fileTag(diff);
        const lines = computeLines(diff.before, diff.after);
        return (
          <div key={diff.path} className="diff-block">
            <div className="diff-file-head">
              <span className={`diff-file-tag ${tag.cls}`}>{tag.label}</span>
              <span>{diff.path}</span>
            </div>
            {diff.before === null ? (
              <div className="diff-line diff-add">
                <span className="ln" />
                <span>{diff.after}</span>
              </div>
            ) : diff.after === null ? (
              <div className="diff-line diff-del">
                <span className="ln" />
                <span>{diff.before}</span>
              </div>
            ) : (
              lines.map((l, i) => (
                <div key={i} className={`diff-line diff-${l.kind}`}>
                  <span className="ln">{l.beforeLn ?? ''}</span>
                  <span className="ln">{l.afterLn ?? ''}</span>
                  <span>{l.text}</span>
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

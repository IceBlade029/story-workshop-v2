/**
 * MarkdownView.tsx — markdown 渲染（marked + DOMPurify）。
 *
 * 渲染前把 {{暂不明示：…}} 标记（§6.1）高亮为 .marker-highlight。
 * 本地单机应用内容，仍走 DOMPurify 消毒。
 */
import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把暂不明示标记转成高亮 span（内容先转义，防注入）。 */
export function highlightMarkers(text: string): string {
  return text.replace(
    /{{暂不明示：([^}]*?)}}/g,
    (_m, content: string) => `<span class="marker-highlight">暂不明示：${escapeHtml(content)}</span>`,
  );
}

/** 统计暂不明示标记数量。 */
export function countMarkers(text: string): number {
  const matches = text.match(/{{暂不明示：/g);
  return matches?.length ?? 0;
}

export function renderMarkdown(text: string): string {
  const highlighted = highlightMarkers(text);
  const html = marked.parse(highlighted, { breaks: true, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}

export function MarkdownView({ text, className }: { text: string; className?: string }): React.ReactElement {
  return (
    <div
      className={`md${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

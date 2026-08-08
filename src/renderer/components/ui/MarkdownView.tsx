/**
 * MarkdownView.tsx — markdown 渲染（marked + DOMPurify + highlight.js）。
 *
 * - 渲染前把 {{暂不明示：…}} 标记（§6.1）高亮为 .marker-highlight。
 * - 代码块经 highlight.js 语法高亮（只产生 class，不违反 CSP；令牌色由
 *   styles.css 用主题变量映射，所有主题自适应）。
 * - style 控制渲染风格：plain = 原样文本（<pre>）；standard / deepseek /
 *   opencode = markdown + 对应 CSS 风格类。
 */
import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import type { OutputStyle } from '../../../shared/llm-types';

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

/** 代码块渲染：带语言 → hljs 高亮；未知语言 → 转义原文。 */
function highlightCode(code: string, language: string | undefined): string {
  const lang = (language ?? '').trim().toLowerCase();
  const escaped = escapeHtml(code);
  if (!lang || !hljs.getLanguage(lang)) return `<pre><code>${escaped}</code></pre>`;
  try {
    const result = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`;
  } catch {
    return `<pre><code>${escaped}</code></pre>`;
  }
}

const mdRenderer = new marked.Renderer();
mdRenderer.code = ({ text, lang }: { text: string; lang?: string; escaped?: boolean }): string => highlightCode(text, lang);

export function renderMarkdown(text: string, style: OutputStyle = 'deepseek'): string {
  const highlighted = highlightMarkers(text);
  const html = marked.parse(highlighted, {
    breaks: true,
    gfm: true,
    renderer: mdRenderer,
  }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * 渲染 Markdown 内容。style === 'plain' 时输出原样文本（保留换行），
 * 其余输出带 md md-style-<style> 类的 HTML。
 */
export function MarkdownView({
  text,
  className,
  style = 'deepseek',
}: {
  text: string;
  className?: string;
  style?: OutputStyle;
}): React.ReactElement {
  if (style === 'plain') {
    return <pre className={`msg-content${className ? ` ${className}` : ''}`}>{text}</pre>;
  }
  return (
    <div
      className={`md md-style-${style}${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, style) }}
    />
  );
}

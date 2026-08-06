/**
 * marker.ts — 暂不明示标记解析与确定性移除（design doc §6.1、§6.3）。
 *
 * 语法：{{暂不明示：内容}} —— 生成可见视图时整段机械移除，不做润色。
 * 规则（§6.1）：
 * - 不支持嵌套：遇到第一个闭合符即结束区间；
 * - 空内容标记（{{暂不明示：}}）整段移除；
 * - 未闭合标记（缺少 }}）视为普通文本保留，不做处理；
 * - 完全由本地纯字符串处理：零 API 调用、即时完成、完全可测。
 */
import { DISCLOSURE_MARKER_OPEN, DISCLOSURE_MARKER_CLOSE } from '../../shared/types';

export interface DisclosureMarkerSpan {
  /** 开标记起始下标（含 {{） */
  start: number;
  /** 闭标记结束下标（含 }}，不包含其后内容） */
  end: number;
  /** 标记区间内文本（不含 {{暂不明示： 与 }}） */
  text: string;
}

/** 找出全部完整标记区间（从左到右；未闭合标记与嵌套内容按 §6.1 规则处理）。 */
export function findDisclosureMarkers(content: string): DisclosureMarkerSpan[] {
  const spans: DisclosureMarkerSpan[] = [];
  let cursor = 0;
  for (;;) {
    const openAt = content.indexOf(DISCLOSURE_MARKER_OPEN, cursor);
    if (openAt < 0) break;
    const contentStart = openAt + DISCLOSURE_MARKER_OPEN.length;
    const closeAt = content.indexOf(DISCLOSURE_MARKER_CLOSE, contentStart);
    if (closeAt < 0) break; // 未闭合：其后全部按普通文本保留
    spans.push({
      start: openAt,
      end: closeAt + DISCLOSURE_MARKER_CLOSE.length,
      text: content.slice(contentStart, closeAt),
    });
    cursor = closeAt + DISCLOSURE_MARKER_CLOSE.length;
  }
  return spans;
}

/** 机械移除全部完整标记区间，返回可见视图文本（无标记时返回原文本）。 */
export function stripDisclosureMarkers(content: string): string {
  const spans = findDisclosureMarkers(content);
  if (spans.length === 0) return content;
  const parts: string[] = [];
  let last = 0;
  for (const span of spans) {
    parts.push(content.slice(last, span.start));
    last = span.end;
  }
  parts.push(content.slice(last));
  return parts.join('');
}

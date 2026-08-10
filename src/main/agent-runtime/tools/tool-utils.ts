/**
 * tool-utils.ts — 工具实现的公共辅助。
 */
import type { EvidenceRef, ToolResult } from '../tool-types';

export function ok<T>(data: T, evidence: EvidenceRef[] = [], truncated = false): ToolResult<T> {
  return { ok: true, data, evidence, truncated };
}

export function fail(code: string, message: string, retryable = false): ToolResult<never> {
  return { ok: false, error: { code, message, retryable }, evidence: [] };
}

export function nodeEvidence(nodeId: string, hash: string, excerpt?: string): EvidenceRef {
  return { sourceId: nodeId, sourceType: 'node', nodeId, hash, excerpt };
}

export function assetEvidence(assetId: string, hash: string, excerpt?: string): EvidenceRef {
  return { sourceId: assetId, sourceType: 'asset', hash, excerpt };
}

export function attachmentEvidence(attachmentId: string, hash: string, excerpt?: string): EvidenceRef {
  return { sourceId: attachmentId, sourceType: 'attachment', hash, excerpt };
}
export function viewEvidence(sceneId: string, hash: string): EvidenceRef {
  return { sourceId: sceneId, sourceType: 'visible_view', hash };
}

/** 简单子串搜索（大小写不敏感；中英文均可）。 */
export function matchesQuery(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/** 大正文工具的确定性分段，防止一次读取把 organize 工具循环上下文塞满。 */
export function sliceToolContent(content: string, start = 0, maxChars = 40_000): {
  content: string;
  range: { start: number; end: number; total: number; hasMore: boolean };
} {
  const safeStart = Math.max(0, Math.min(Math.floor(start), content.length));
  const safeMax = Math.max(1_000, Math.min(Math.floor(maxChars), 100_000));
  const end = Math.min(content.length, safeStart + safeMax);
  return {
    content: content.slice(safeStart, end),
    range: { start: safeStart, end, total: content.length, hasMore: end < content.length },
  };
}

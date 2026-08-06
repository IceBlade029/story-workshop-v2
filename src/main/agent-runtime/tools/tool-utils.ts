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

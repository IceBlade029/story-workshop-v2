/**
 * hash.ts — Content hashing utilities.
 *
 * 新鲜度全部用 hash 比对，不用状态机（design doc §4.3）。
 * 所有「内容是否变化」的判断都基于 sha256。
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function sha256OfFile(filePath: string): string {
  return sha256(readFileSync(filePath, 'utf-8'));
}

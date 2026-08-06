/**
 * id.ts — Stable id generation for storage entities.
 */
import { randomBytes } from 'crypto';

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/**
 * atomic-write.ts — Atomic file write operations.
 *
 * All writes go through tmp → open+fsync+close → rename to prevent data
 * corruption on crash.  If the process dies mid-write, the original file
 * is untouched because rename() is atomic on the same filesystem.
 *
 * Flow per write: writeFileSync(tmp, content) → openSync(tmp) →
 *                 fsyncSync(fd) → closeSync(fd) → renameSync(tmp, target)
 *
 * Usage:
 *   writeJsonAtomic("/path/to/data.json", { key: "value" })
 *   writeTextAtomic("/path/to/doc.md", "# Title\n\nContent")
 *   writeMarkdownAtomic("/path/to/doc.md", "# Title\n\nContent")
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Generate a unique temporary file path in the same directory as the target.
 * Using the same directory ensures rename() is atomic (same filesystem).
 */
function tmpPath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const unique = crypto.randomBytes(6).toString('hex');
  return path.join(dir, `.${base}.${unique}.tmp`);
}

/**
 * Core atomic write implementation.
 *
 * 1. Write content to a temporary file
 * 2. Open the temporary file and fsync the descriptor so data hits disk
 * 3. Close the descriptor
 * 4. rename the temporary file to the target path (atomic)
 * 5. On any failure: clean up the temporary file and re-throw
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = tmpPath(filePath);
  const dir = path.dirname(filePath);

  // Ensure parent directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Write JSON data atomically.
 *
 * Flow: tmp file → fsync → rename → target path
 * If the write fails (disk full, crash), the original file is preserved.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  atomicWrite(filePath, content);
}

/**
 * Write text content atomically.
 *
 * Flow: tmp file → fsync → rename → target path
 */
export function writeTextAtomic(filePath: string, content: string): void {
  atomicWrite(filePath, content);
}

/**
 * Write Markdown content atomically.
 *
 * Flow: tmp file → fsync → rename → target path
 */
export function writeMarkdownAtomic(filePath: string, content: string): void {
  atomicWrite(filePath, content);
}

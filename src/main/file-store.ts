/**
 * file-store.ts — Generic file system helpers.
 *
 * Provides synchronous, crash-safe file operations shared across the app.
 * The outline-specific persistence logic is intentionally NOT part of this
 * module — storage-layer code lives in dedicated repositories (see design
 * doc §4).
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write';

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON data atomically (tmp → rename).
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  writeJsonAtomic(filePath, data);
}

export function readMarkdownFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write text content atomically (tmp → rename).
 */
export function writeMarkdownFile(filePath: string, content: string): void {
  writeTextAtomic(filePath, content);
}

export function copyFile(src: string, dest: string): void {
  const dir = path.dirname(dest);
  ensureDir(dir);
  fs.copyFileSync(src, dest);
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function listDirs(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function deleteDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

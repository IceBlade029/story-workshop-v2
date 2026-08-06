import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('file-store generic helpers', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), `file-store-v2-test-${randomSuffix()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  beforeEach(() => {
    try {
      const entries = fs.readdirSync(testDir);
      for (const entry of entries) {
        fs.rmSync(path.join(testDir, entry), { recursive: true, force: true });
      }
    } catch { /* ok */ }
  });

  it('ensureDir creates nested directories recursively', async () => {
    const { ensureDir } = await import('../file-store');
    const dir = path.join(testDir, 'a', 'b', 'c');
    ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('readJsonFile returns null for missing file', async () => {
    const { readJsonFile } = await import('../file-store');
    expect(readJsonFile(path.join(testDir, 'missing.json'))).toBeNull();
  });

  it('readJsonFile returns null for corrupt JSON without throwing', async () => {
    const { readJsonFile } = await import('../file-store');
    const p = path.join(testDir, 'bad.json');
    fs.writeFileSync(p, '{{invalid', 'utf-8');
    expect(() => readJsonFile(p)).not.toThrow();
    expect(readJsonFile(p)).toBeNull();
  });

  it('writeJsonFile + readJsonFile round-trips data', async () => {
    const { writeJsonFile, readJsonFile } = await import('../file-store');
    const p = path.join(testDir, 'data.json');
    writeJsonFile(p, { a: 1, b: 'x' });
    expect(readJsonFile<{ a: number; b: string }>(p)).toEqual({ a: 1, b: 'x' });
  });

  it('readMarkdownFile returns empty string for missing file', async () => {
    const { readMarkdownFile } = await import('../file-store');
    expect(readMarkdownFile(path.join(testDir, 'missing.md'))).toBe('');
  });

  it('writeMarkdownFile + readMarkdownFile round-trips text', async () => {
    const { writeMarkdownFile, readMarkdownFile } = await import('../file-store');
    const p = path.join(testDir, 'doc.md');
    writeMarkdownFile(p, '# Title\n\nContent');
    expect(readMarkdownFile(p)).toBe('# Title\n\nContent');
  });

  it('copyFile copies to nested destination, creating parent dirs', async () => {
    const { copyFile } = await import('../file-store');
    const src = path.join(testDir, 'src.txt');
    const dest = path.join(testDir, 'nested', 'dest.txt');
    fs.writeFileSync(src, 'hello', 'utf-8');
    copyFile(src, dest);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('hello');
  });

  it('fileExists reflects presence', async () => {
    const { fileExists } = await import('../file-store');
    const p = path.join(testDir, 'x.txt');
    expect(fileExists(p)).toBe(false);
    fs.writeFileSync(p, '', 'utf-8');
    expect(fileExists(p)).toBe(true);
  });

  it('listDirs returns only directories', async () => {
    const { listDirs } = await import('../file-store');
    fs.mkdirSync(path.join(testDir, 'dir1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'dir2'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'file1.txt'), '', 'utf-8');
    const dirs = listDirs(testDir).sort();
    expect(dirs).toEqual(['dir1', 'dir2']);
  });

  it('listDirs returns [] for missing directory', async () => {
    const { listDirs } = await import('../file-store');
    expect(listDirs(path.join(testDir, 'nope'))).toEqual([]);
  });

  it('deleteDir removes directory tree', async () => {
    const { deleteDir } = await import('../file-store');
    const dir = path.join(testDir, 'gone');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), '', 'utf-8');
    deleteDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => deleteDir(dir)).not.toThrow();
  });
});

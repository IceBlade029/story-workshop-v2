/**
 * templates.ts — 内置格式模板（design doc §6.5）。
 *
 * 模板 = 文本指南 + 元信息。新增媒介（如漫画分镜）只是新增一个模板，
 * 不引入任何新机制。M5 会细化模板内容；M3 提供可用的基础版。
 */
import * as fs from 'fs';
import * as path from 'path';

export const BUILTIN_FORMAT_TEMPLATES: Record<string, string> = {
  novel: `# 小说格式指南

- 叙事体，第三人称为主
- 段落式，中文全角标点；对话用中文引号「」
- 一个场景写成一段连续的叙事，有自然起承转合
- 保留可见视图中的全部信息，只做展开，不新增事实
- 不要出现「场景名」「细纲」等结构性字样`,
  script: `# 剧本格式指南

- 场次标题：第 N 场 · 地点 · 时间
- 对白：角色名：对白
- 动作：以（动作）形式插在相应对白前后
- 一个场景 = 一个场次；信息不足处标「待定」
- 保留可见视图中的全部信息，只做展开，不新增事实`,
};

export class FormatTemplateRepository {
  constructor(
    /** 额外模板目录（可选）；内置模板优先被同名覆盖 */
    private readonly extraDir?: string,
  ) {}

  private readonly builtin: Record<string, string> = BUILTIN_FORMAT_TEMPLATES;

  read(format: string): string | null {
    if (this.extraDir) {
      try {
        const file = path.join(this.extraDir, `${format}.md`);
        if (fs.existsSync(file)) {
          return fs.readFileSync(file, 'utf-8');
        }
      } catch {
        /* 落到内置模板 */
      }
    }
    return this.builtin[format] ?? null;
  }

  listFormats(): string[] {
    const formats = new Set<string>(Object.keys(this.builtin));
    if (this.extraDir) {
      try {
        if (fs.existsSync(this.extraDir)) {
          for (const f of fs.readdirSync(this.extraDir)) {
            if (f.endsWith('.md')) formats.add(f.slice(0, -3));
          }
        }
      } catch {
        /* ignore */
      }
    }
    return [...formats].sort();
  }
}

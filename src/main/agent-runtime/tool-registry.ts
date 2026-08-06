/**
 * tool-registry.ts — 工具注册表与白名单强制（design doc §8.2）。
 *
 * 工具白名单只用于知识边界：每个任务类型只能看到/调用白名单内的工具。
 * 白名单之外的工具调用被硬拒绝（TOOL_NOT_IN_WHITELIST）——这是物理边界，
 * 不依赖提示词。
 */
import type { ToolSpec } from './tool-types';
import type { TaskKind } from '../../shared/types';

export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.specs.has(spec.name)) {
      throw new Error(`DUPLICATE_TOOL: ${spec.name}`);
    }
    this.specs.set(spec.name, spec);
  }

  registerAll(specs: ToolSpec[]): void {
    for (const spec of specs) this.register(spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.specs.get(name);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  list(): ToolSpec[] {
    return [...this.specs.values()];
  }

  /** 某任务类型白名单内的全部工具规格（按注册顺序）。 */
  getToolsForTask(kind: TaskKind, whitelist: string[]): ToolSpec[] {
    const tools: ToolSpec[] = [];
    for (const name of whitelist) {
      const spec = this.specs.get(name);
      if (spec) tools.push(spec);
    }
    return tools;
  }

  /** 白名单强制：断言该任务允许调用此工具，否则抛错。 */
  assertAllowed(kind: TaskKind, whitelist: string[], toolName: string): void {
    if (!whitelist.includes(toolName)) {
      throw new Error(`TOOL_NOT_IN_WHITELIST: ${toolName} (task=${kind})`);
    }
  }
}

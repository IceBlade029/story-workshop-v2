import { describe, it, expect, afterAll } from 'vitest';
import { ToolRegistry } from '../../agent-runtime/tool-registry';
import { TASK_DEFINITIONS } from '../../agent-runtime/task-definitions';
import { createAgentRuntime } from '../../agent-runtime/agent-factory';
import { ScriptedModelAdapter } from '../../agent-runtime/scripted-model-adapter';
import { ProjectWorkspace } from '../../storage/workspace';
import { makeProject, removeDir } from '../helpers/temp-project';

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function makeRuntime() {
  const { projectDir } = makeProject();
  tempDirs.push(projectDir);
  const workspace = ProjectWorkspace.open(projectDir)!;
  const model = new ScriptedModelAdapter();
  return createAgentRuntime(workspace, model);
}

describe('task-definitions — 白名单（§8.2 精确集合）', () => {
  const CHAT_READ = ['search_nodes', 'search_conversation', 'read_node', 'read_draft', 'list_nodes', 'read_asset', 'list_assets', 'list_attachments', 'read_attachment', 'list_all_attachments', 'read_any_attachment', 'read_visible_view'];
  const CHAT = [...CHAT_READ, 'web_search'];

  it('chat：只有只读工具（+ 服务端联网搜索），无任何写入工具', () => {
    expect(TASK_DEFINITIONS.chat.whitelist).toEqual(CHAT);
    const writeTools = ['write_draft', 'create_node', 'rename_node', 'delete_node', 'write_asset', 'write_output'];
    for (const t of writeTools) expect(TASK_DEFINITIONS.chat.whitelist).not.toContain(t);
    expect(TASK_DEFINITIONS.chat.systemPrompt).toContain('联网搜索');
  });

  it('organize：chat 只读全部 + 5 个写入工具（无联网搜索）', () => {
    expect(TASK_DEFINITIONS.organize.whitelist).toEqual([...CHAT_READ, 'write_draft', 'create_node', 'rename_node', 'delete_node', 'write_asset']);
    expect(TASK_DEFINITIONS.organize.whitelist).not.toContain('web_search');
  });

  it('四个任务类型：chat / organize / detail_fill / revise（§8.2 + ux-review §5.3）', () => {
    expect(Object.keys(TASK_DEFINITIONS).sort()).toEqual(['chat', 'detail_fill', 'organize', 'revise']);
  });

  it('detail_fill：只有可见视图 + 格式模板 + 输出（物理上拿不到细纲/设定/材料/标记）', () => {
    expect(TASK_DEFINITIONS.detail_fill.whitelist).toEqual(['read_visible_view', 'read_format_template', 'write_output']);
    for (const t of ['read_node', 'read_draft', 'search_nodes', 'list_nodes', 'read_asset', 'list_assets', 'list_attachments', 'read_attachment']) {
      expect(TASK_DEFINITIONS.detail_fill.whitelist).not.toContain(t);
    }
  });

  it('revise（就地改写）：只读可见视图/设定/当前输出，无写入工具（§5.3 替换精度契约）', () => {
    expect(TASK_DEFINITIONS.revise.whitelist).toEqual(['read_visible_view', 'read_asset', 'list_assets', 'read_output']);
    for (const t of ['write_draft', 'create_node', 'rename_node', 'delete_node', 'write_asset', 'write_output', 'read_node', 'read_draft', 'search_nodes', 'list_nodes']) {
      expect(TASK_DEFINITIONS.revise.whitelist).not.toContain(t);
    }
    // 替换精度契约
    expect(TASK_DEFINITIONS.revise.systemPrompt).toContain('完整替换文本');
    expect(TASK_DEFINITIONS.revise.systemPrompt).toContain('选中区间');
  });

  it('organize 系统提示包含不补写原则与披露意图规则（§5.3、§6.2）', () => {
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('整理只允许提取和归纳');
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('待定');
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('AI 建议');
    // 披露意图转译（§6.2）
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('{{暂不明示：内容}}');
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('不得编造披露意图');
    expect(TASK_DEFINITIONS.organize.systemPrompt).toContain('转译');
  });
});

describe('tool-registry — 注册与强制', () => {
  it('注册全部工具，名字唯一', () => {
    const { registry } = makeRuntime();
    const names = registry.list().map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of Object.values(TASK_DEFINITIONS)) {
      for (const name of t.whitelist) {
        expect(registry.has(name)).toBe(true);
      }
    }
  });

  it('重复注册抛错', () => {
    const registry = new ToolRegistry();
    const spec = { name: 'x', description: 'd', inputSchema: {} as never, outputSchema: {} as never, execute: async () => ({ ok: true, evidence: [] }) };
    registry.register(spec as never);
    expect(() => registry.register(spec as never)).toThrow('DUPLICATE_TOOL');
  });

  it('getToolsForTask 只返回白名单内的工具', () => {
    const { registry } = makeRuntime();
    const detailTools = registry.getToolsForTask('detail_fill', TASK_DEFINITIONS.detail_fill.whitelist);
    expect(detailTools.map((t) => t.name)).toEqual(['read_visible_view', 'read_format_template', 'write_output']);
  });

  it('assertAllowed 拒绝白名单外工具', () => {
    const registry = new ToolRegistry();
    expect(() => registry.assertAllowed('detail_fill', TASK_DEFINITIONS.detail_fill.whitelist, 'read_node')).toThrow('TOOL_NOT_IN_WHITELIST');
    expect(() => registry.assertAllowed('chat', TASK_DEFINITIONS.chat.whitelist, 'write_draft')).toThrow('TOOL_NOT_IN_WHITELIST');
  });
});

/**
 * agent-factory.ts — Agent 运行时装配（工具注册 + 运行协调器）。
 *
 * M4 的 UI 层与测试统一从这里获得装配好的运行时。
 */
import { ToolRegistry } from './tool-registry';
import { RunCoordinator } from './run-loop';
import { makeNodeReadTools } from './tools/node-tools';
import { makeAssetReadTools } from './tools/asset-tools';
import { makeAttachmentReadTools } from './tools/attachment-tools';
import { makeConversationReadTools } from './tools/conversation-tools';
import { makeWriteTools } from './tools/write-tools';
import { makeDetailTools } from './tools/detail-tools';
import { makeWebSearchTool } from './tools/websearch-tool';
import { FormatTemplateRepository } from './templates';
import type { ModelAdapter } from './model-types';
import type { ProjectWorkspace } from '../storage/workspace';

export interface AgentRuntime {
  workspace: ProjectWorkspace;
  registry: ToolRegistry;
  coordinator: RunCoordinator;
}

export function createAgentRuntime(
  workspace: ProjectWorkspace,
  model: ModelAdapter,
  options?: { templates?: FormatTemplateRepository },
): AgentRuntime {
  const registry = new ToolRegistry();
  const projectDir = () => workspace.dir;
  registry.registerAll(makeNodeReadTools(projectDir));
  registry.registerAll(makeAssetReadTools(projectDir));
  registry.registerAll(makeAttachmentReadTools(projectDir));
  registry.registerAll(makeConversationReadTools(projectDir));
  registry.registerAll(makeWriteTools(projectDir));
  registry.registerAll(makeDetailTools(projectDir, options?.templates));
  registry.registerAll([makeWebSearchTool()]);

  const coordinator = new RunCoordinator({ model, workspace, registry });
  return { workspace, registry, coordinator };
}

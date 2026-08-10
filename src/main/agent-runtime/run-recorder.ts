/**
 * run-recorder.ts — 变更摘要与回滚（design doc §5.4）+ 调用详情记录（ux-review §4.7）。
 *
 * 可写任务运行前：快照受影响文件到 snapshots/<runId>/（§9.1）。
 * 运行结束：变更摘要（RunSummary）落盘为 snapshots/<runId>/summary.json。
 * 每条 run 的「调用详情」落盘 conversation/runs/<runId>.json（§4.7：应用给模型发了什么、
 * 模型返回了什么——全任务一致透明）。
 *
 * 用户操作：
 * - 接受：保留草稿，清除「AI 新增」标记（clearAiCreated）。
 * - 回滚：从快照恢复全部受影响文件（整体可回滚，不需要逐条审批）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeJsonFile, fileExists, ensureDir } from '../file-store';
import type { ChangeItem, RunRecord, RunSummary, TaskKind } from '../../shared/types';
import type { ProjectWorkspace } from '../storage/workspace';

/** 运行内变更记录器（由 RunCoordinator 注入工具上下文）。 */
export class RunRecorder {
  readonly changes: ChangeItem[] = [];

  record(change: ChangeItem): void {
    this.changes.push(change);
  }
}

export interface RunSummaryPayload {
  runId: string;
  taskKind: TaskKind;
  snapshotId: string;
  scope: string;
  instruction?: string;
  sourceMessageIds?: string[];
  sourceAttachmentIds?: string[];
  rootRunId?: string;
  parentRunId?: string;
  revisionMode?: 'local' | 'global';
  revisionTargets?: string[];
  finalAnswer?: string;
  changes: ChangeItem[];
}

/** 把结构化变更摘要落盘到快照目录（与快照共存，回滚后仍可查阅）。 */
export function persistRunSummary(workspace: ProjectWorkspace, payload: RunSummaryPayload): void {
  const summary: RunSummary = {
    runId: payload.runId,
    taskKind: payload.taskKind,
    snapshotId: payload.snapshotId,
    scope: payload.scope,
    instruction: payload.instruction,
    sourceMessageIds: payload.sourceMessageIds,
    sourceAttachmentIds: payload.sourceAttachmentIds,
    rootRunId: payload.rootRunId ?? payload.runId,
    parentRunId: payload.parentRunId,
    revisionMode: payload.revisionMode,
    revisionTargets: payload.revisionTargets,
    reviewStatus: 'pending',
    finalAnswer: payload.finalAnswer,
    changes: payload.changes,
  };
  writeJsonFile(
    path.join(workspace.dir, 'snapshots', payload.runId, 'summary.json'),
    summary,
  );
}

export function updateRunReviewStatus(
  workspace: ProjectWorkspace,
  runId: string,
  reviewStatus: NonNullable<RunSummary['reviewStatus']>,
): void {
  const summary = readRunSummary(workspace, runId);
  if (!summary) throw new Error(`RUN_SUMMARY_NOT_FOUND: ${runId}`);
  writeJsonFile(
    path.join(workspace.dir, 'snapshots', runId, 'summary.json'),
    { ...summary, reviewStatus },
  );
}

export function readRunSummary(workspace: ProjectWorkspace, runId: string): RunSummary | null {
  const file = path.join(workspace.dir, 'snapshots', runId, 'summary.json');
  if (!fileExists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RunSummary;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 调用详情（§4.7）

function recordFilePath(workspace: ProjectWorkspace, runId: string): string {
  return path.join(workspace.dir, 'conversation', 'runs', `${runId}.json`);
}

/** 把一次 run 的调用详情落盘（§4.7；全部任务一致记录）。 */
export function persistRunRecord(workspace: ProjectWorkspace, record: RunRecord): void {
  ensureDir(path.join(workspace.dir, 'conversation', 'runs'));
  writeJsonFile(recordFilePath(workspace, record.runId), record);
}

/** 读取调用详情；不存在返回 null。 */
export function readRunRecord(workspace: ProjectWorkspace, runId: string): RunRecord | null {
  const file = recordFilePath(workspace, runId);
  if (!fileExists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RunRecord;
  } catch {
    return null;
  }
}

/** 接受：保留草稿与设定，清除该 run 创建节点的「AI 新增」标记（§5.4）。 */
export function acceptRun(workspace: ProjectWorkspace, runId: string): void {
  const summary = readRunSummary(workspace, runId);
  const createdNodeIds = (summary?.changes ?? [])
    .filter((c): c is Extract<ChangeItem, { action: 'node_created' }> => c.action === 'node_created')
    .map((c) => c.nodeId);
  if (createdNodeIds.length > 0) {
    workspace.outline.clearAiCreated(createdNodeIds);
  }
}

/** 回滚：从快照恢复全部受影响文件（§5.4、§9.1）。 */
export function rollbackRun(workspace: ProjectWorkspace, runId: string): string[] {
  return workspace.snapshots.restoreSnapshot(runId);
}

/**
 * app-service.ts — 应用业务层（M4）。
 *
 * 全部 IPC 通道背后的真实逻辑：项目打开/创建、状态汇总、大纲/设定/材料操作、
 * 批量提交正式版、消息树操作（发送/刷新/分支切换/新话题）、run 启动（上下文
 * 组装 + 光标推进）、变更摘要列表/接受/回滚、API key。
 *
 * 与 electron 解耦（不 import electron），便于单元测试：注入 workspace 与 model。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProjectWorkspace } from './storage/workspace';
import { OutlineRepository, OVERVIEW_ROOT_ID } from './storage/outline-repository';
import { VisibleViewService } from './storage/visible-view-service';
import { FormatTemplateRepository } from './agent-runtime/templates';
import { createAgentRuntime, type AgentRuntime } from './agent-runtime/agent-factory';
import { acceptRun, rollbackRun, readRunSummary, readRunRecord } from './agent-runtime/run-recorder';
import { TASK_DEFINITIONS } from './agent-runtime/task-definitions';
import {
  CONTEXT_BUDGET_TOKENS,
  contextInputFingerprint,
  estimateTrailingTokens,
  estimatePathTokens,
  planCompression,
  runCompressionTask,
  summaryMessage,
} from './agent-runtime/context-compression';
import { generateId } from './storage/id';
import { sha256 } from './storage/hash';
import { assertSafeId, assertSafeFormat } from './storage/path-safety';
import { saveApiKey, hasApiKey, loadApiKeyEntry } from './api-key-store';
import { getSettings, saveSettings } from './settings-store';
import type { AppSettings } from '../shared/llm-types';
import type { ModelAdapter } from './agent-runtime/model-types';
import type { RunResult, RunRequest } from './agent-runtime/run-loop';
import type { ChangeItem, ChatMessage, Attachment, NodeType, OutlineNode, ToolCallTrace, VisibleView, ConversationSession } from '../shared/types';
import type {
  CommitResult,
  NodeSummary,
  OrganizeScope,
  OutputInfo,
  ProjectState,
  RunStartRequest,
} from '../shared/ipc-types';

export interface AppRunHooks {
  onChunk?: (text: string) => void;
  /** 思维链增量（DeepSeek V4 思考模式；UI 思考进度） */
  onReasoning?: (text: string) => void;
  /** 服务端联网搜索状态（Responses API 原生 web_search；UI 搜索进度） */
  onSearchStatus?: (status: 'searching' | 'completed') => void;
  onToolTrace?: (trace: ToolCallTrace) => void;
}

/** run 结果；无内容可整理时 skippedReason 非空 */
export type AppRunResult = RunResult & { skippedReason?: string };

/**
 * 附件正文内联上限（字符）：首次回答上下文把附件正文直接注入消息（ChatGPT/
 * DeepSeek 式，保证首轮不因未读附件而幻觉）。超过上限不内联，由系统提示
 * 硬性要求模型先 read_attachment 读取。
 */
const MAX_INLINE_ATTACHMENT_CHARS = 12000;

export class AppService {
  private runtime: AgentRuntime | null = null;
  /** 当前项目的模型实例（压缩任务直接单轮调用，§7.3） */
  private model: ModelAdapter | null = null;
  /** 主进程运行互斥（P1 修复）：同一时刻只允许一个 run 在跑。 */
  private runActive = false;

  constructor(private readonly createModel: () => ModelAdapter) {}

  /**
   * 项目操作守卫（P1 修复）：run 进行中禁止切换/关闭/删除项目。
   */
  private assertNoActiveRun(): void {
    if (this.runActive) throw new Error('RUN_IN_PROGRESS: 任务运行中，请等待完成或取消后再切换/关闭项目');
  }

  get workspace(): ProjectWorkspace {
    if (!this.runtime) throw new Error('NO_PROJECT_OPEN');
    return this.runtime.workspace;
  }

  get dir(): string {
    return this.workspace.dir;
  }

  /** 可见视图服务（§6.3：确定性生成 + hash 新鲜度，无模型参与）。 */
  private visibleViews(): VisibleViewService {
    return new VisibleViewService(this.workspace.outline, this.workspace.visibleViews);
  }

  /** 细纲变更后的可见视图新鲜度同步（自动重生成 / 置失效，§6.3）。 */
  private syncVisibleViews(sceneIds?: string[]): void {
    this.visibleViews().syncStale(sceneIds);
  }

  // -------------------------------------------------------------- 项目

  createProject(projectDir: string, name: string): ProjectState {
    this.assertNoActiveRun();
    const workspace = ProjectWorkspace.create(projectDir, name);
    this.model = this.createModel();
    this.runtime = createAgentRuntime(workspace, this.model);
    return this.getState();
  }

  openProject(projectDir: string): ProjectState {
    this.assertNoActiveRun();
    const workspace = ProjectWorkspace.open(projectDir);
    if (!workspace) throw new Error('NOT_A_PROJECT');
    this.model = this.createModel();
    this.runtime = createAgentRuntime(workspace, this.model);
    return this.getState();
  }

  closeProject(): void {
    this.assertNoActiveRun();
    this.runtime = null;
    this.model = null;
  }

  /** 重命名项目（§6.10：仅更新 project.json 中的名称，目录名不变）。 */
  renameProject(dir: string, name: string): ProjectState {
    const n = name.trim();
    if (!n) throw new Error('EMPTY_PROJECT_NAME');
    if (this.runtime === null || this.dir !== dir) throw new Error('NO_PROJECT_OPEN');
    this.workspace.project.rename(n);
    return this.getState();
  }

  /**
   * 全局搜索（§6.9）：跨大纲（标题/草稿/正式版）、设定、对话、附件正文、
   * 已生成正文、可见视图。大小写不敏感子串匹配；每类上限 20 条。
   */
  globalSearch(query: string): Array<import('../shared/ipc-types').GlobalSearchResult> {
    const ws = this.workspace;
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const out: Array<import('../shared/ipc-types').GlobalSearchResult> = [];
    const LIMIT = 20;
    const matches = (text: string): boolean => text.toLowerCase().includes(q);
    const excerpt = (text: string): string => {
      const idx = text.toLowerCase().indexOf(q);
      if (idx < 0) return text.slice(0, 100);
      const start = Math.max(0, idx - 30);
      return text.slice(start, Math.min(text.length, idx + q.length + 60));
    };
    const push = (r: import('../shared/ipc-types').GlobalSearchResult): boolean => {
      if (out.length >= LIMIT) return false;
      out.push(r);
      return true;
    };

    // 1) 大纲节点：标题 → 草稿 → 正式版（命中一项即记录）
    const tree = ws.outline.readTree();
    if (tree) {
      const walk = (node: OutlineNode): boolean => {
        if (matches(node.title)) {
          return push({ kind: 'node', id: node.id, title: node.title, excerpt: excerpt(node.title) });
        }
        const draft = ws.outline.hasDraft(node.id) ? ws.outline.readDraft(node.id) : '';
        if (draft && matches(draft)) return push({ kind: 'node', id: node.id, title: node.title, excerpt: excerpt(draft) });
        const official = ws.outline.hasOfficial(node.id) ? ws.outline.readOfficial(node.id) : '';
        if (official && matches(official)) return push({ kind: 'node', id: node.id, title: node.title, excerpt: excerpt(official) });
        for (const child of node.children) if (!walk(child)) return false;
        return true;
      };
      walk(tree.root);
    }

    // 2) 设定：标题/类型/正文
    for (const a of ws.assets.listAssets()) {
      if (out.length >= LIMIT) break;
      if (matches(a.title) || matches(a.type) || matches(a.content)) {
        push({ kind: 'asset', id: a.id, title: a.title || '（未命名）', excerpt: excerpt(a.title + a.content) });
      }
    }

    // 3) 对话消息（含归档会话）
    const convMessages = ws.conversation.readMessages();
    const sessions = ws.conversation.listSessions();
    const byId = new Map(convMessages.map((m) => [m.id, m]));
    const sessionOf = (m: { id: string; parentId?: string }): ConversationSession | null => {
      let current: { id: string; parentId?: string } | undefined = byId.get(m.id);
      while (current) {
        if (!current.parentId || !byId.has(current.parentId)) {
          const rootId = current.id;
          return sessions.find((s) => ws.conversation.sessionRootMessageId(s) === rootId) ?? null;
        }
        current = byId.get(current.parentId);
      }
      return null;
    };
    for (const m of convMessages) {
      if (out.length >= LIMIT) break;
      if (!matches(m.content)) continue;
      const session = sessionOf(m);
      push({
        kind: 'conversation',
        id: m.id,
        title: `消息 · ${m.role === 'user' ? '你' : 'AI'}`,
        excerpt: excerpt(m.content),
        meta: session ? session.title : undefined,
      });
    }

    // 4) 附件正文（meta 带第一条引用它的消息 id，供跳转定位）
    for (const meta of ws.attachments.listAttachments()) {
      if (out.length >= LIMIT) break;
      const read = ws.attachments.readAttachment(meta.id);
      if (!read) continue;
      if (matches(read.content) || matches(meta.name)) {
        const refMsg = convMessages.find((m) => m.refs?.attachmentIds?.includes(meta.id));
        push({
          kind: 'attachment',
          id: meta.id,
          title: meta.name,
          excerpt: excerpt(read.content),
          meta: refMsg ? `msg:${refMsg.id}` : undefined,
        });
      }
    }

    // 5) 已生成正文（outputs/<scene>.<format>.md）
    try {
      const outputsDir = path.join(ws.dir, 'outputs');
      for (const f of fs.readdirSync(outputsDir)) {
        if (out.length >= LIMIT) break;
        if (!f.endsWith('.md')) continue;
        const base = f.slice(0, -'.md'.length);
        const dot = base.lastIndexOf('.');
        if (dot <= 0) continue;
        const sceneId = base.slice(0, dot);
        const format = base.slice(dot + 1);
        const content = fs.readFileSync(path.join(outputsDir, f), 'utf-8');
        if (matches(content)) {
          const node = ws.outline.findNode(sceneId);
          push({ kind: 'output', id: sceneId, title: `${node?.title ?? sceneId}（${format}）`, excerpt: excerpt(content), meta: format });
        }
      }
    } catch {
      /* outputs 目录不存在 */
    }

    // 6) 可见视图
    try {
      const viewsDir = path.join(ws.dir, 'visible_views');
      for (const f of fs.readdirSync(viewsDir)) {
        if (out.length >= LIMIT) break;
        if (!f.endsWith('.json')) continue;
        const sceneId = f.slice(0, -'.json'.length);
        const view = ws.visibleViews.read(sceneId);
        if (view && matches(view.content)) {
          const node = ws.outline.findNode(sceneId);
          push({ kind: 'visible_view', id: sceneId, title: `${node?.title ?? sceneId} 的可见视图`, excerpt: excerpt(view.content) });
        }
      }
    } catch {
      /* visible_views 目录不存在 */
    }

    return out;
  }

  /**
   * 删除项目（显式操作，确认后移到系统回收站）：校验目录确实是项目
   * （含 project.json），若为当前打开项目则先关闭。实际删除（回收站）
   * 由调用方（ipc 层）执行，这里保持与 electron 解耦。
   */
  deleteProject(dir: string): { wasOpen: boolean } {
    const fs = require('fs') as typeof import('fs');
    const metaFile = path.join(dir, 'project.json');
    if (!fs.existsSync(metaFile)) throw new Error(`NOT_A_PROJECT: ${dir}`);
    const wasOpen = this.runtime !== null && this.dir === dir;
    if (wasOpen) {
      this.assertNoActiveRun();
      this.closeProject();
    }
    return { wasOpen };
  }

  /** 从目录名推断可展示的项目信息（用于项目列表）。 */
  static listProjects(baseDir: string): Array<{ dir: string; name: string; createdAt: string }> {
    const fs = require('fs') as typeof import('fs');
    try {
      const out: Array<{ dir: string; name: string; createdAt: string }> = [];
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(baseDir, entry.name);
        const metaFile = path.join(dir, 'project.json');
        if (!fs.existsSync(metaFile)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { name: string; createdAt: string };
          out.push({ dir, name: meta.name, createdAt: meta.createdAt });
        } catch {
          /* 跳过损坏项目 */
        }
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * 递归拷贝目录（逐文件 copyFileSync + mkdirSync）。
   * 不用 fs.cpSync：Node 22 Windows 下中文路径（如项目目录名）会原生崩溃
   * （ACCESS_VIOLATION，uv_fs_copyfile 已知问题）；copyFileSync 安全。
   */
  private static copyDir(src: string, dest: string): void {
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
      }
    }
  }

  /**
   * 更改项目存储目录（设置弹窗「存储」区块）：
   * - migrate=true：把旧目录下全部项目搬到新目录——全部拷贝成功后才删除旧目录
   *   （拷贝中途失败时旧目录保留，数据零丢失；重名自动加 -2 后缀）。
   * - migrate=false：仅切换位置，旧项目留在原地（仍可通过「打开文件夹…」打开）。
   * - 当前打开的项目被搬走 → 自动从新路径重开，UI 无缝续用。
   * 落盘 settings.json 后返回迁移结果。
   */
  setProjectsDir(oldBase: string, newBase: string, migrate: boolean): { movedCount: number; reopened: boolean } {
    this.assertNoActiveRun();
    const fs = require('fs') as typeof import('fs');
    if (newBase.trim() === '' || !path.isAbsolute(newBase)) {
      throw new Error('INVALID_PROJECTS_DIR: 存储位置必须是绝对路径');
    }
    const projects = AppService.listProjects(oldBase);
    const moved: string[] = [];
    let movedOpen: string | null = null;
    if (migrate) {
      if (oldBase === newBase) throw new Error('SAME_PROJECTS_DIR: 新旧位置相同，无需迁移');
      if (projects.length > 0) {
        fs.mkdirSync(newBase, { recursive: true });
        for (const p of projects) {
          let dest = path.join(newBase, path.basename(p.dir));
          let n = 2;
          while (fs.existsSync(dest)) {
            dest = path.join(newBase, `${path.basename(p.dir)}-${n}`);
            n++;
          }
          AppService.copyDir(p.dir, dest);
          moved.push(p.dir);
          if (this.runtime && this.dir === p.dir) movedOpen = dest;
        }
        // 全部拷贝成功后才删除旧目录（残留删除失败不影响使用）
        for (const src of moved) {
          try {
            fs.rmSync(src, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
    }
    if (movedOpen) {
      this.closeProject(); // runtime 持有旧路径仓库，须重建
      this.openProject(movedOpen);
    }
    saveSettings({ projectsDir: newBase });
    return { movedCount: moved.length, reopened: movedOpen !== null };
  }

  // -------------------------------------------------------------- 状态

  getState(): ProjectState {
    const ws = this.workspace;
    // 幂等物化初始会话（ChatGPT 式对话，ux-review §4.5：旧项目打开也连续）
    ws.conversation.ensureInitialSession();
    const tree = ws.outline.readTree();
    const messages = ws.conversation.readMessagesWithTree();
    const runSummaries = AppService.collectRunSummaries(ws);
    const keyEntry = loadApiKeyEntry('deepseek');
    return {
      dir: ws.dir,
      name: ws.project.getMeta().name,
      outline: tree,
      nodes: tree ? this.flattenNodes(tree) : [],
      assets: ws.assets.listAssets(),
      attachments: ws.attachments.attachFreshness(ws.attachments.listAttachments()),
      messages,
      sessions: ws.conversation.listSessions(),
      activeSessionId: ws.conversation.getActiveSessionId(),
      activeMessageId: ws.conversation.getActiveMessageId(),
      organizeCursor: ws.conversation.getOrganizeCursor(),
      runSummaries,
      hasApiKey: hasApiKey('deepseek'),
      maskedApiKey: keyEntry?.maskedKey,
      trash: ws.trash.list(),
      settings: getSettings(),
    };
  }

  private flattenNodes(tree: { root: { id: string; type: NodeType; title: string; children: unknown[]; hidden?: boolean; aiCreated?: boolean } }): NodeSummary[] {
    const outline = this.workspace.outline;
    const outputs = this.workspace.outputs;
    const out: NodeSummary[] = [];
    const walk = (
      node: { id: string; type: NodeType; title: string; children: typeof tree.root.children; hidden?: boolean; aiCreated?: boolean },
      parentId: string | null,
      depth: number,
    ): void => {
      const meta = outline.readMeta(node.id);
      const isScene = node.type === 'scene';
      let outputStale: string[] = [];
      if (isScene) {
        const view = this.workspace.visibleViews.read(node.id);
        const viewHash = view ? sha256(view.content) : null;
        outputStale = outputs.listForScene(node.id, viewHash).filter((o) => o.stale).map((o) => o.format);
      }
      out.push({
        id: node.id,
        type: node.type,
        title: node.title,
        parentId,
        depth,
        hidden: node.hidden,
        aiCreated: node.aiCreated,
        hasDraft: outline.hasDraft(node.id),
        hasOfficial: outline.hasOfficial(node.id),
        draftHash: meta.draftHash,
        officialHash: meta.officialHash,
        updatedAt: meta.updatedAt,
        visibleView: meta.visibleView,
        outputFormats: isScene ? outputs.listFormatsForScene(node.id) : [],
        outputStale,
      });
      for (const child of node.children as Array<{ id: string; type: NodeType; title: string; children: unknown[]; hidden?: boolean; aiCreated?: boolean }>) {
        walk(child, node.id, depth + 1);
      }
    };
    walk(tree.root, null, 0);
    return out;
  }

  private static collectRunSummaries(ws: ProjectWorkspace): Array<import('../shared/ipc-types').RunSummaryEntry> {
    const out: Array<import('../shared/ipc-types').RunSummaryEntry> = [];
    for (const runId of ws.snapshots.listSnapshots()) {
      const summary = readRunSummary(ws, runId);
      const manifest = ws.snapshots.readManifest(runId);
      if (summary) {
        out.push({ ...summary, createdAt: manifest?.createdAt ?? '' });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // -------------------------------------------------------------- 大纲

  createNode(parentId: string, type: NodeType, title: string): ProjectState {
    this.workspace.outline.createNode(parentId, { id: generateId('n'), type, title, children: [] });
    return this.getState();
  }

  renameNode(nodeId: string, title: string): ProjectState {
    this.workspace.outline.renameNode(nodeId, title);
    return this.getState();
  }

  /** 移动节点到新父节点（§3.1 大纲顺序；index 缺省 = 追加末尾）。 */
  moveNode(nodeId: string, newParentId: string, index?: number): ProjectState {
    this.workspace.outline.moveNode(nodeId, newParentId, index);
    return this.getState();
  }

  deleteNode(nodeId: string): ProjectState {
    const ws = this.workspace;
    if (nodeId === OVERVIEW_ROOT_ID) throw new Error('CANNOT_REMOVE_ROOT');
    ws.trash.moveToTrash(nodeId); // §9.4：删除先进回收站，永久删除需单独确认
    return this.getState();
  }

  /** 恢复回收站条目（§9.4）。 */
  restoreTrash(trashId: string): ProjectState {
    this.workspace.trash.restore(trashId);
    return this.getState();
  }

  /** 永久删除回收站条目（§9.4：需单独确认）。 */
  purgeTrash(trashId: string): ProjectState {
    this.workspace.trash.purge(trashId);
    return this.getState();
  }

  /** 读取节点内容（正式版/草稿；右栏编辑器初始化与可见视图对照浏览）。 */
  readNodeContent(nodeId: string): import('../shared/ipc-types').NodeContent {
    const ws = this.workspace;
    const node = ws.outline.findNode(nodeId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${nodeId}`);
    return {
      id: node.id,
      title: node.title,
      type: node.type,
      official: ws.outline.hasOfficial(nodeId) ? ws.outline.readOfficial(nodeId) : null,
      draft: ws.outline.hasDraft(nodeId) ? ws.outline.readDraft(nodeId) : null,
    };
  }

  writeDraft(nodeId: string, content: string): ProjectState {
    this.workspace.outline.writeDraft(nodeId, content);
    this.visibleViews().syncStale([nodeId]);
    return this.getState();
  }

  writeOfficial(nodeId: string, content: string): ProjectState {
    this.workspace.outline.writeOfficial(nodeId, content);
    this.visibleViews().syncStale([nodeId]);
    return this.getState();
  }

  /** 收集子树全部节点 id（含自身）。 */
  private collectSubtree(nodeId: string): string[] {
    const ws = this.workspace;
    const ids: string[] = [];
    const walk = (id: string): void => {
      ids.push(id);
      const node = ws.outline.findNode(id);
      for (const child of node?.children ?? []) walk(child.id);
    };
    walk(nodeId);
    return ids;
  }

  /**
   * 批量提交正式版（§5.5）：草稿复制为正式版 + 更新 hash + 写快照。
   * 默认排除带「待定：」标记的节点；includePending 显式覆盖。
   */
  commitNodes(nodeIds: string[], includePending = false): CommitResult {
    const ws = this.workspace;
    const affected = [...new Set(nodeIds.flatMap((id) => this.collectSubtree(id)))];
    const committed: string[] = [];
    const skippedPending: string[] = [];
    for (const id of affected) {
      if (!ws.outline.hasDraft(id)) continue;
      const draft = ws.outline.readDraft(id);
      if (draft.includes('待定：') && !includePending) {
        skippedPending.push(id);
        continue;
      }
      committed.push(id);
    }
    if (committed.length > 0) {
      const runId = `commit-${Date.now()}`;
      // 先写正式版，再快照（§5.5：快照 = 该节点版本历史的一页，需捕获提交后的版本）
      for (const id of committed) {
        ws.outline.writeOfficial(id, ws.outline.readDraft(id));
      }
      const files = [
        path.join(ws.dir, 'outline.json'),
        ...committed.flatMap((id) => {
          const safeId = assertSafeId(id, 'node');
          return [
            path.join(ws.dir, 'nodes', `${safeId}.md`),
            path.join(ws.dir, 'nodes', `${safeId}.meta.json`),
          ];
        }),
      ];
      ws.snapshots.createSnapshot(runId, files);
      ws.snapshots.pruneRetention();
      this.syncVisibleViews(committed);
      return { runId, committed, skippedPending, affected };
    }
    return { runId: '', committed, skippedPending, affected };
  }

  // -------------------------------------------------------------- 设定

  createAsset(type: string, title: string, content: string): ProjectState {
    this.workspace.assets.createAsset(type, title, content);
    return this.getState();
  }

  updateAsset(assetId: string, updates: { title?: string; type?: string; content?: string }): ProjectState {
    const updated = this.workspace.assets.updateAsset(assetId, updates);
    if (!updated) throw new Error('ASSET_NOT_FOUND');
    return this.getState();
  }

  deleteAsset(assetId: string): ProjectState {
    this.workspace.assets.deleteAsset(assetId);
    return this.getState();
  }

  // -------------------------------------------------------------- 材料

  /**
   * 文本落为附件（ux-review §3），并作为引用消息进入对话。
   * source：pasted（粘贴长文本）/ uploaded（上传、拖入文件）。
   */
  addAttachment(name: string, content: string, source: Attachment['source'] = 'pasted'): ProjectState {
    const ws = this.workspace;
    const attachment = ws.attachments.createAttachment(name, content, source);
    ws.conversation.appendMessage({
      id: generateId('msg'),
      role: 'user',
      content: `（附件：${name}）`,
      timestamp: new Date().toISOString(),
      refs: { attachmentIds: [attachment.id] },
    });
    return this.getState();
  }

  /**
   * 项目文件夹中已有的文件（§3.3 source: 'workspace'）：
   * 扫描项目根目录顶层散落的文本文件（排除系统目录与元数据文件）。
   */
  scanWorkspaceFiles(): Array<{ name: string; size: number }> {
    const fs = require('fs') as typeof import('fs');
    const systemDirs = new Set([
      'nodes', 'conversation', 'attachments', 'world', 'visible_views', 'outputs', 'snapshots', 'trash',
    ]);
    const reserved = new Set(['project.json', 'outline.json']);
    try {
      return fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !reserved.has(e.name) && /\.(md|txt|markdown)$/i.test(e.name))
        .map((e) => ({ name: e.name, size: fs.statSync(path.join(this.dir, e.name)).size }));
    } catch {
      return [];
    }
  }

  /** 只读项目顶层文本文件（待发送附件预读用）；系统目录/保留文件返回 null。 */
  readWorkspaceFile(name: string): { name: string; content: string } | null {
    const fs = require('fs') as typeof import('fs');
    const available = new Set(this.scanWorkspaceFiles().map((f) => f.name));
    if (!available.has(name)) return null;
    const file = path.join(this.dir, name);
    try {
      return { name, content: fs.readFileSync(file, 'utf-8') };
    } catch {
      return null;
    }
  }

  /** 把项目文件夹中的文件收纳为附件（内容复制进 attachments/，原文件不移动不删除；§3.1）。 */
  importWorkspaceFiles(names: string[]): ProjectState {
    const ws = this.workspace;
    const fs = require('fs') as typeof import('fs');
    const available = new Set(this.scanWorkspaceFiles().map((f) => f.name));
    for (const name of names) {
      if (!available.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const attachment = ws.attachments.createAttachment(name, content, 'workspace');
        ws.conversation.appendMessage({
          id: generateId('msg'),
          role: 'user',
          content: `（附件：${name}）`,
          timestamp: new Date().toISOString(),
          refs: { attachmentIds: [attachment.id] },
        });
      } catch {
        /* 单个文件失败跳过 */
      }
    }
    return this.getState();
  }

  /** 读取附件完整正文（附件行展开用）；不存在返回 null。 */
  readAttachmentContent(attachmentId: string): { name: string; content: string } | null {
    const read = this.workspace.attachments.readAttachment(attachmentId);
    if (!read) return null;
    return { name: read.meta.name, content: read.content };
  }

  /** 删除附件（显式操作，确认后永久删除）：附件是项目一等对象，删除与任何会话无关。 */
  deleteAttachment(attachmentId: string): ProjectState {
    this.workspace.attachments.deleteAttachment(attachmentId);
    return this.getState();
  }

  // -------------------------------------------------------------- 可见视图（§6）

  /** 生成（或重新生成）可见视图（§6.3）。重新生成会覆盖手改——UI 负责确认。 */
  generateVisibleView(sceneId: string): ProjectState {
    this.visibleViews().generate(sceneId);
    return this.getState();
  }

  /** 保存手改（§6.4）：置位 userEdited 并清除失效标记。 */
  updateVisibleView(sceneId: string, content: string): ProjectState {
    this.visibleViews().saveUserEdit(sceneId, content);
    return this.getState();
  }

  /** 读取场景可见视图；不存在返回 null。 */
  readVisibleView(sceneId: string): VisibleView | null {
    return this.workspace.visibleViews.read(sceneId);
  }

  /** 场景输出列表（含失效标记，§3.5）。 */
  listOutputs(sceneId: string): OutputInfo[] {
    const ws = this.workspace;
    const view = ws.visibleViews.read(sceneId);
    return ws.outputs.listForScene(sceneId, view ? sha256(view.content) : null);
  }

  /** 可用正文格式（模板清单，§6.6）。 */
  listFormats(): string[] {
    return new FormatTemplateRepository().listFormats();
  }

  /**
   * 手工保存正文（§6.5 修订）：写入前快照（output-<ts>，含该输出文件与输出索引），
   * 恢复/版本历史与失效检测（viewHash）保持一致。视图 hash 沿用当前可见视图
   * ——可见视图未变则保存不产生失效标记。
   */
  saveOutput(sceneId: string, format: string, content: string): ProjectState {
    const ws = this.workspace;
    const node = ws.outline.findNode(sceneId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${sceneId}`);
    if (node.type !== 'scene') throw new Error(`NOT_SCENE_NODE: ${sceneId}`);
    const safeId = assertSafeId(sceneId, 'scene');
    const safeFormat = assertSafeFormat(format);
    // 同一毫秒内多次保存会撞 id 覆盖快照（Date.now 粒度不够）→ 加随机后缀
    const snapshotId = `output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    ws.snapshots.createSnapshot(snapshotId, [
      path.join(ws.dir, 'outputs', `${safeId}.${safeFormat}.md`),
      path.join(ws.dir, 'outputs', 'index.json'),
    ]);
    // 首版保存（写前文件不存在）：快照目录里留空文件占位 → 版本历史保留
    // 「保存前无正文」这一版（否则首版内容只存在于 HEAD，换版后丢失）。
    const snapshotOutputFile = path.join(ws.dir, 'snapshots', snapshotId, 'outputs', `${safeId}.${safeFormat}.md`);
    if (!fs.existsSync(snapshotOutputFile)) {
      fs.mkdirSync(path.dirname(snapshotOutputFile), { recursive: true });
      fs.writeFileSync(snapshotOutputFile, '', 'utf-8');
    }
    ws.snapshots.pruneRetention();
    const view = ws.visibleViews.read(sceneId);
    ws.outputs.write(sceneId, format, content, view ? sha256(view.content) : '');
    return this.getState();
  }

  /**
   * 正文版本历史（§6.5 修订）：扫描全部快照中该场景输出文件（生成/改写/手工保存
   * 的写前快照各成一版），并把当前正文作为最新一版（snapshotId='current'）——
   * 新建的第一版正文/最近一次改写没有写后快照，HEAD 保证它们始终在列表中。
   */
  listOutputVersions(sceneId: string, format: string): import('../shared/ipc-types').OutputVersion[] {
    const ws = this.workspace;
    const safeId = assertSafeId(sceneId, 'scene');
    const safeFormat = assertSafeFormat(format);
    const out: import('../shared/ipc-types').OutputVersion[] = [];
    for (const snapshotId of ws.snapshots.listSnapshots()) {
      const file = path.join(ws.dir, 'snapshots', snapshotId, 'outputs', `${safeId}.${safeFormat}.md`);
      try {
        if (!fs.existsSync(file)) continue;
        const manifest = ws.snapshots.readManifest(snapshotId);
        const content = fs.readFileSync(file, 'utf-8');
        out.push({ snapshotId, createdAt: manifest?.createdAt ?? '', hash: sha256(content) });
      } catch {
        /* 跳过损坏快照 */
      }
    }
    // HEAD：当前正文作为最新一版
    const currentFile = path.join(ws.dir, 'outputs', `${safeId}.${safeFormat}.md`);
    try {
      if (fs.existsSync(currentFile)) {
        out.unshift({
          snapshotId: 'current',
          createdAt: fs.statSync(currentFile).mtime.toISOString(),
          hash: sha256(fs.readFileSync(currentFile, 'utf-8')),
        });
      }
    } catch {
      /* 读不到当前文件则只有快照版本 */
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 读取某版本快照中的正文内容；snapshotId='current' = 当前正文。 */
  readOutputVersion(sceneId: string, format: string, snapshotId: string): string {
    if (snapshotId === 'current') return this.workspace.outputs.read(sceneId, format);
    const file = path.join(
      this.workspace.dir,
      'snapshots',
      assertSafeId(snapshotId, 'snapshot'),
      'outputs',
      `${assertSafeId(sceneId, 'scene')}.${assertSafeFormat(format)}.md`,
    );
    if (!fs.existsSync(file)) throw new Error(`VERSION_NOT_FOUND: ${snapshotId}`);
    return fs.readFileSync(file, 'utf-8');
  }

  /**
   * 整书导出（§6.7）：按大纲树顺序合并各场景正文为单文件。
   * 缺失正文的场景收集进 missing（不阻断导出）；标题可选包含
   * （隐藏中间层级的章同样输出标题，与左栏显示一致）。
   */
  exportBook(format: string, options: { includeTitles: boolean }): { content: string; missing: Array<{ nodeId: string; title: string }> } {
    const ws = this.workspace;
    const safeFormat = assertSafeFormat(format);
    const tree = ws.outline.readTree();
    if (!tree) throw new Error('OUTLINE_NOT_INITIALIZED');
    const missing: Array<{ nodeId: string; title: string }> = [];
    const parts: string[] = [];
    const walk = (node: OutlineNode, depth: number): void => {
      if (node.type === 'scene') {
        const content = ws.outputs.exists(node.id, safeFormat) ? ws.outputs.read(node.id, safeFormat) : '';
        if (content.trim() === '') {
          missing.push({ nodeId: node.id, title: node.title });
        } else {
          if (options.includeTitles && node.title) parts.push(`\n# ${node.title}\n`);
          parts.push(content);
        }
        return;
      }
      if (options.includeTitles && node.title && node.type !== 'overview') {
        parts.push(`\n${depth <= 1 ? '# ' : '## '}${node.title}\n`);
      }
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(tree.root, 0);
    const joined = parts.join('\n\n---\n\n').trim();
    return { content: joined === '' ? '' : joined + '\n', missing };
  }

  // -------------------------------------------------------------- 对话

  sendMessage(content: string): ProjectState {
    const ws = this.workspace;
    // 归档守卫（ux-review §4.5）：归档会话完全只读，不能继续追加对话
    if (this.isActiveSessionArchived()) throw new Error('SESSION_ARCHIVED');
    const message: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content: content.trim() === '' ? '（消息）' : content,
      timestamp: new Date().toISOString(),
    };
    ws.conversation.appendMessage(message);
    return this.getState();
  }

  /**
   * 一次提交「文本 + 待发送附件」（ChatGPT 式：附件先在输入框上方暂存，
   * 发送时才落盘进对话）。逐个附件持久化并追加引用消息（日志只存引用，
   * §3.1），再追加用户文本消息。内容为空且无附件 → 抛 EMPTY_SEND。
   */
  sendWithAttachments(content: string, attachments: Array<{ name: string; content: string; source?: Attachment['source'] }>): ProjectState {
    const ws = this.workspace;
    if (this.isActiveSessionArchived()) throw new Error('SESSION_ARCHIVED');
    const text = content.trim();
    if (text === '' && attachments.length === 0) throw new Error('EMPTY_SEND');
    const now = new Date().toISOString();
    for (const a of attachments) {
      const attachment = ws.attachments.createAttachment(a.name, a.content, a.source ?? 'uploaded');
      ws.conversation.appendMessage({
        id: generateId('msg'),
        role: 'user',
        content: `（附件：${a.name}）`,
        timestamp: now,
        refs: { attachmentIds: [attachment.id] },
      });
    }
    if (text !== '') {
      ws.conversation.appendMessage({
        id: generateId('msg'),
        role: 'user',
        content: text,
        timestamp: now,
      });
    }
    return this.getState();
  }

  /**
   * 开启新话题（ux-review §4.5）：新建空会话并设为活动。
   * 不归档、不删除当前话题——旧话题保持活跃，可随时切回继续追加。
   * 自动命名「话题 N」（可传 title 覆盖）。
   * 用户反馈：当前话题为空（尚无任何消息）时不允许新建话题。
   */
  newTopic(title?: string): ProjectState {
    const ws = this.workspace;
    ws.conversation.ensureInitialSession();
    const sid = ws.conversation.getActiveSessionId();
    const session = sid ? ws.conversation.getSession(sid) : null;
    if (session && !session.tailMessageId) throw new Error('TOPIC_EMPTY');
    ws.conversation.createSession(title?.trim() || undefined);
    return this.getState();
  }

  /** 切换会话（ChatGPT 式）：活动路径末端 = 该会话 tail；空会话 → 空视图。 */
  switchSession(sessionId: string): ProjectState {
    this.workspace.conversation.switchSession(sessionId);
    return this.getState();
  }

  /** 显式归档（ux-review §4.5）：完全只读，移入「归档」层级；可取消归档。 */
  archiveSession(sessionId: string): ProjectState {
    this.workspace.conversation.archiveSession(sessionId);
    return this.getState();
  }

  /** 取消归档：移回活跃层，恢复可继续追加。 */
  unarchiveSession(sessionId: string): ProjectState {
    this.workspace.conversation.unarchiveSession(sessionId);
    return this.getState();
  }

  /** 删除会话（显式操作，确认后永久删除）：会话子树消息从日志剔除。 */
  deleteSession(sessionId: string): ProjectState {
    this.workspace.conversation.deleteSession(sessionId);
    return this.getState();
  }

  /** 活动会话是否已归档（只读守卫，ux-review §4.5）。 */
  private isActiveSessionArchived(): boolean {
    const ws = this.workspace;
    const sid = ws.conversation.getActiveSessionId();
    return sid ? (ws.conversation.getSession(sid)?.archived ?? false) : false;
  }

  switchBranch(messageId: string): ProjectState {
    this.workspace.conversation.setActiveMessage(messageId);
    return this.getState();
  }

  // -------------------------------------------------------------- run

  /** 组装 organize 范围（ux-review §4.2：范围 = 未整理 / 全部 + 自然语言附注）。 */
  private resolveOrganizeScope(scope: OrganizeScope): { messages: ChatMessage[]; scopeText: string } {
    const conv = this.workspace.conversation;
    if (scope.type === 'unorganized') {
      const messages = conv.readUnorganizedMessages();
      const cursor = conv.getOrganizeCursor();
      const scopeText = cursor
        ? `第 ${conv.readActivePath().findIndex((m) => m.id === cursor) + 1}–${conv.readActivePath().length} 轮未整理对话（光标：#${cursor}）`
        : `全部未整理对话（无光标）`;
      return { messages, scopeText };
    }
    // 'all'：重新整理全部对话
    const messages = conv.readMessages();
    return { messages, scopeText: '重新整理全部对话（全部历史）' };
  }

  /** 启动一次 run（chat / organize），返回结果；无内容可整理时 skippedReason。 */
  async run(req: RunStartRequest, hooks: AppRunHooks = {}, signal?: AbortSignal): Promise<AppRunResult> {
    if (this.runActive) throw new Error('RUN_ALREADY_ACTIVE: 已有任务在运行，请先等待完成或取消');
    this.runActive = true;
    try {
    const ws = this.workspace;
    if (!this.runtime) throw new Error('NO_PROJECT_OPEN');
    // 归档守卫（ux-review §4.5）：归档会话完全只读，不能继续对话/整理
    if (this.isActiveSessionArchived()) throw new Error('SESSION_ARCHIVED');

    let request: RunRequest;
    if (req.kind === 'organize') {
      const { messages, scopeText } = this.resolveOrganizeScope(req.scope ?? { type: 'unorganized' });
      if (messages.length === 0) {
        return { runId: '', taskKind: 'organize', finalAnswer: '', turns: 0, toolCallCount: 0, writeToolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, changes: [], cancelled: false, skippedReason: '没有未整理的内容' };
      }
      request = {
        taskKind: 'organize',
        // Part 5：范围消息同样内联附件正文，organize 首轮即可读取
        messages: this.prepareModelMessages(messages),
        scope: scopeText + (req.note ? `；附注：${req.note}` : ''),
      };
    } else {
      // §7.2 上下文组装：压缩摘要（沿活动路径）+ 最近几轮原文 + 当前输入
      // Part 5：先内联附件正文（内存视图，token 预算在 planCompression 前正确计入）
      const path = this.prepareModelMessages(ws.conversation.readActivePath());
      const ctx = await this.prepareChatContext(path);
      if (ctx.eventText) this.appendSystemEvent(ctx.eventText, path.at(-1)?.id);
      else if (ctx.failureText) this.appendSystemEvent(ctx.failureText, path.at(-1)?.id);
      request = {
        taskKind: 'chat',
        messages: ctx.messages,
        parentMessageId: req.parentMessageId ?? path.at(-1)?.id,
        contextInfo: ctx.contextInfo,
        // 每次发送由聊天工具栏选择的回答详略档位
        answerDetail: req.answerDetail,
      };
    }

    const result = await this.runtime.coordinator.run({
      ...request,
      signal,
      // 全局「最大输出长度」设置（长文评价被截断时可调大）
      maxOutputTokens: getSettings().maxOutputTokens,
      onChunk: hooks.onChunk,
      onReasoning: hooks.onReasoning,
      onSearchStatus: hooks.onSearchStatus,
      onToolTrace: hooks.onToolTrace,
    });
    // AI 写入（organize 的 write_draft）后同步可见视图新鲜度（§6.3 自动重生成）
    this.syncVisibleViews();
    // 快照保留策略（§12.1 决定：保留全部 commit，运行快照最多 50 个）
    ws.snapshots.pruneRetention();
    // §4.3：整理范围消化过的附件记录所用 hash（附件后变 → 附件行提示「已更新」）
    if (req.kind === 'organize' && !result.error && !result.cancelled) {
      // 整理成功（含硬门禁通过）→ 光标推进到范围最后一条消息（§5.3；
      // organize 沙箱化后日志零新增，光标不再指向运行结束事件）
      const scopeTail = request.messages.at(-1)?.id;
      if (scopeTail) ws.conversation.setOrganizeCursor(scopeTail);
      const marked = new Set<string>();
      for (const m of request.messages) {
        for (const id of m.refs?.attachmentIds ?? []) {
          if (!marked.has(id)) {
            marked.add(id);
            ws.attachments.markStructured(id, result.runId);
          }
        }
      }
    }
    // 用户反馈 2：首个对话 run 完成后自动命名会话标题（ChatGPT/DeepSeek 式）；
    // 命名失败静默保留「话题 N」占位，下次 chat run 自动重试。
    if (req.kind === 'chat' && !result.error && !result.cancelled) {
      const sid = ws.conversation.getActiveSessionId();
      if (sid) {
        try {
          await this.autoTitleSession(sid);
        } catch {
          /* 命名失败不阻断 run 结果 */
        }
      }
    }
    return result;
    } finally {
      this.runActive = false;
    }
  }

  /**
   * AI 自动命名（用户反馈 2）：根据会话首条用户消息生成简短标题，
   * 替换「话题 N」占位。单轮只读模型调用（无工具），成功后写入
   * setSessionTitle（titleAuto=false）；失败抛错由调用方静默处理。
   */
  private async autoTitleSession(sessionId: string): Promise<void> {
    const ws = this.workspace;
    const session = ws.conversation.getSession(sessionId);
    if (!session || !session.titleAuto || !this.model) return;
    const byId = new Map(ws.conversation.readMessages().map((m) => [m.id, m]));
    let firstUser: string | undefined;
    let current = session.tailMessageId ? byId.get(session.tailMessageId) : undefined;
    while (current) {
      if (current.role === 'user') {
        firstUser = current.content;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!firstUser) return;
    const turn = await this.model.runTurn(
      {
        systemPrompt: '你是对话标题生成器。为下面的故事创作讨论生成一个简短的中文会话标题（不超过 16 字，直指主题；只输出标题本身，不要引号、冒号或解释）。',
        messages: [{ role: 'user', content: `讨论内容：\n${firstUser.slice(0, 500)}` }],
      },
      { maxTokens: 64 },
    );
    if (turn.type !== 'final') return;
    const title = turn.answer
      .trim()
      .replace(/^["'「『“]+/, '')
      .replace(/["'」』”]+$/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 24);
    if (title) ws.conversation.setSessionTitle(sessionId, title);
  }

  /**
   * 模型消息预处理（Part 5）：把带附件引用的消息展开为正文内联的内存副本
   * （不写日志、不改原消息），并剔除「（消息已编辑）原内容：…」记账事件
   * （旧文本不进模型上下文——编辑后的新版本才是权威内容；存量日志兜底）。
   * 附件 ≤ MAX_INLINE_ATTACHMENT_CHARS 直接注入正文，保证模型首轮就能看到
   * 内容（消除「未读附件就回答」的幻觉）；超限不内联，提示必须
   * read_attachment；附件已删除时提示缺失。在 planCompression 之前调用，
   * token 预算正确计入。
   */
  private prepareModelMessages(messages: ChatMessage[]): ChatMessage[] {
    const ws = this.workspace;
    const out: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system' && m.content.startsWith('（消息已编辑）')) continue;
      const ids = m.refs?.attachmentIds;
      if (!ids || ids.length === 0) {
        out.push(m);
        continue;
      }
      const parts: string[] = [];
      for (const id of ids) {
        const read = ws.attachments.readAttachment(id);
        if (!read) {
          parts.push(`（附件已被删除：${id}）`);
          continue;
        }
        const { meta, content } = read;
        const name = meta.name;
        if (content.length <= MAX_INLINE_ATTACHMENT_CHARS) {
          parts.push(`（附件：${name}）\n【附件正文（${content.length} 字）】\n${content}\n【附件正文结束】`);
        } else {
          parts.push(`（附件：${name}）\n（正文 ${content.length} 字，过大未内联；回答前必须先调用 read_attachment 读取完整正文）`);
        }
      }
      out.push(parts.length === 0 ? m : { ...m, content: parts.join('\n\n') });
    }
    return out;
  }

  /**
   * 两阶段压缩接入（§7.2、§7.3、§7.4）：
   * 超预算 → 先查分支摘要（锚点 = 被压缩前缀最后一条消息），无则跑一次
   * 只读压缩任务并落盘摘要；压缩失败按恢复链回退，耗尽后置 compressionBlocked
   * 暂停自动压缩（原始对话没有丢失），本轮按原文继续。
   * 压缩决策（anchor/keptFrom）随 contextInfo 返回，进调用详情（§4.7）。
   */
  private async prepareChatContext(path: ChatMessage[], focus?: string): Promise<{ messages: ChatMessage[]; eventText?: string; failureText?: string; contextInfo?: { anchor: string; summary: string; keptFrom: number; keptRawCount: number } }> {
    const ws = this.workspace;
    const plan = planCompression(ws, path);
    if (!plan.needsCompression || !plan.anchor) return { messages: path };
    const anchor = plan.anchor;
    const keptCount = path.length - plan.keptFrom;
    // 被压缩前缀引用的附件 id（透传给摘要消息 → 本轮附件范围不丢，Part 2）
    const compressedRefs = { attachmentIds: [...new Set(path.slice(0, plan.keptFrom).flatMap((m) => m.refs?.attachmentIds ?? []))] };
    const existing = ws.conversation.readBranchSummary(anchor);
    if (existing) {
      return {
        messages: [summaryMessage(anchor, existing, compressedRefs), ...path.slice(plan.keptFrom)],
        contextInfo: { anchor, summary: existing, keptFrom: plan.keptFrom, keptRawCount: keptCount },
      };
    }
    const outcome = await runCompressionTask(ws, this.model!, path.slice(0, plan.keptFrom), focus);
    if (!outcome.ok) {
      ws.conversation.updateMeta({ compressionBlocked: true });
      return {
        messages: path,
        failureText: `压缩失败：${outcome.error}；原始对话没有丢失，本轮按原文继续。可稍后手动重新压缩（§7.4）。`,
      };
    }
    ws.conversation.writeBranchSummary(anchor, outcome.summary!);
    return {
      messages: [summaryMessage(anchor, outcome.summary!, compressedRefs), ...path.slice(plan.keptFrom)],
      eventText: `已压缩较早的讨论上下文（覆盖第 1–${plan.keptFrom} 条消息，最近 ${keptCount} 条保留原文）`,
      contextInfo: { anchor, summary: outcome.summary!, keptFrom: plan.keptFrom, keptRawCount: keptCount },
    };
  }

  /** 上下文视图（§7.3 只读透明度工具）：展示一次模型调用实际收到什么。 */
  inspectContext(): import('../shared/ipc-types').ContextInspection {
    const ws = this.workspace;
    // Part 5：与实际调用一致，先内联附件正文再估算
    const path = this.prepareModelMessages(ws.conversation.readActivePath());
    const plan = planCompression(ws, path);
    const summary = plan.anchor ? ws.conversation.readBranchSummary(plan.anchor) : '';
    const compressedRefs = plan.needsCompression
      ? { attachmentIds: [...new Set(path.slice(0, plan.keptFrom).flatMap((m) => m.refs?.attachmentIds ?? []))] }
      : undefined;
    // inspect 是只读操作：已有摘要时按下一次真实调用的「摘要 + 最近原文」组装；
    // 尚无摘要或压缩被阻断时，本轮仍会按完整活动路径计算。
    const effectivePath = plan.needsCompression && plan.anchor && summary
      ? [summaryMessage(plan.anchor, summary, compressedRefs), ...path.slice(plan.keptFrom)]
      : path;
    let usedTokens = estimatePathTokens(effectivePath);
    let measurement: 'server-anchored' | 'estimated' = 'estimated';
    let providerTokens: number | undefined;
    let trailingEstimatedTokens: number | undefined;
    let transientEstimatedTokens: number | undefined;
    let anchorMessageId: string | undefined;
    // 从后向前寻找最近一个仍匹配当前输入前缀的服务端快照。分支切换、消息编辑、
    // 摘要变化都会改变指纹，使旧锚点自动失效并安全回退到全量估算。
    for (let i = effectivePath.length - 1; i >= 0; i--) {
      const message = effectivePath[i];
      const anchor = message.role === 'ai' ? message.contextUsage : undefined;
      if (!anchor || anchor.inputTokens + anchor.outputTokens <= 0) continue;
      if (anchor.inputFingerprint !== contextInputFingerprint(effectivePath.slice(0, i))) continue;
      providerTokens = anchor.inputTokens + anchor.outputTokens;
      trailingEstimatedTokens = estimateTrailingTokens(effectivePath.slice(i + 1));
      transientEstimatedTokens = anchor.transientEstimatedTokens ?? 0;
      usedTokens = Math.max(0, providerTokens - transientEstimatedTokens) + trailingEstimatedTokens;
      measurement = 'server-anchored';
      anchorMessageId = message.id;
      break;
    }
    return {
      messageCount: path.length,
      budgetTokens: CONTEXT_BUDGET_TOKENS,
      usedTokens,
      estimatedTokens: estimatePathTokens(path),
      measurement,
      ...(providerTokens !== undefined ? { providerTokens } : {}),
      ...(trailingEstimatedTokens !== undefined ? { trailingEstimatedTokens } : {}),
      ...(transientEstimatedTokens !== undefined ? { transientEstimatedTokens } : {}),
      ...(anchorMessageId ? { anchorMessageId } : {}),
      compressed: plan.needsCompression && summary !== '',
      keptRawCount: plan.needsCompression ? path.length - plan.keptFrom : path.length,
      summaryAnchor: plan.needsCompression ? plan.anchor : undefined,
      summary: summary || undefined,
      blocked: plan.blocked ?? false,
    };
  }

  /**
   * 手动重新压缩（§7.3）：清除压缩阻断标记；指定「压缩重点」只影响摘要
   * 详略，不改变内容权威。压缩任务是只读的，没有写入工具。
   */
  async recompressContext(focus?: string): Promise<ProjectState> {
    const ws = this.workspace;
    ws.conversation.updateMeta({ compressionBlocked: false });
    const path = ws.conversation.readActivePath();
    const plan = planCompression(ws, path);
    const tailId = path.at(-1)?.id;
    if (plan.needsCompression && plan.anchor) {
      const outcome = await runCompressionTask(ws, this.model!, path.slice(0, plan.keptFrom), focus);
      if (outcome.ok) {
        ws.conversation.writeBranchSummary(plan.anchor, outcome.summary!);
        this.appendSystemEvent(
          `已重新压缩较早的讨论上下文（覆盖第 1–${plan.keptFrom} 条消息，最近 ${path.length - plan.keptFrom} 条保留原文）`,
          tailId,
        );
      } else {
        ws.conversation.updateMeta({ compressionBlocked: true });
        this.appendSystemEvent(`压缩失败：${outcome.error}；原始对话没有丢失（§7.4）`, tailId);
      }
    } else {
      this.appendSystemEvent('当前上下文未超预算，无需压缩（已清除压缩阻断标记）', tailId);
    }
    return this.getState();
  }

  /** 追加一条 system 记账事件（§7.1：全部事件落日志，不改写旧行）。 */
  private appendSystemEvent(content: string, parentId?: string): void {
    this.workspace.conversation.appendMessage({
      id: generateId('msg'),
      role: 'system',
      content,
      timestamp: new Date().toISOString(),
      ...(parentId ? { parentId } : {}),
    });
  }

  /** 编辑用户消息 → 分支（§3.2）。归档会话完全只读（ux-review §4.5）。 */
  editMessage(messageId: string, content: string): ProjectState {
    if (this.isActiveSessionArchived()) throw new Error('SESSION_ARCHIVED');
    this.workspace.conversation.editMessage(messageId, content);
    return this.getState();
  }

  /**
   * 正文生成（§6.5，detail_fill）：只读该场景可见视图 + 格式模板，
   * 输出落盘 outputs/<sceneId>.<format>.md。反馈重生成 = 旧输出 + 反馈
   * 作为输入（仍只读可见视图）。视图与细纲不一致（needsRegeneration）
   * 时拒绝运行，提示先处理（§6.4）。
   *
   * 沙箱隔离（ux-review §5.2 修订）：写作任务不产生任何对话消息——
   * 正文生成/改写的产物只留在 outputs/ 与调用详情记录里，讨论模块零痕迹。
   */
  async runDetailFill(sceneId: string, format: string, feedback?: string, hooks: AppRunHooks = {}, signal?: AbortSignal): Promise<RunResult> {
    if (this.runActive) throw new Error('RUN_ALREADY_ACTIVE: 已有任务在运行，请先等待完成或取消');
    this.runActive = true;
    try {
    const ws = this.workspace;
    if (!this.runtime) throw new Error('NO_PROJECT_OPEN');
    const node = ws.outline.findNode(sceneId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${sceneId}`);
    if (node.type !== 'scene') throw new Error(`NOT_SCENE_NODE: ${sceneId}`);
    const view = ws.visibleViews.read(sceneId);
    if (!view) throw new Error('NO_VISIBLE_VIEW：请先生成可见视图');
    if (view.needsRegeneration) throw new Error('VIEW_NEEDS_REGENERATION：可见视图与细纲不一致，请先重新生成');

    const taskMessage: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content: `请把场景 ${sceneId} 的可见视图扩写为${format}格式的完整正文，用 write_output 落盘。`,
      timestamp: new Date().toISOString(),
    };
    let scope = `生成正文：${sceneId} · ${format}`;
    if (feedback && feedback.trim() !== '') {
      const previous = ws.outputs.exists(sceneId, format) ? ws.outputs.read(sceneId, format) : '';
      taskMessage.content += previous
        ? `\n\n上一版输出：\n${previous}\n\n请根据以下反馈修改并重新生成：${feedback.trim()}`
        : `\n\n请根据以下反馈生成：${feedback.trim()}`;
      scope += `；反馈：${feedback.trim()}`;
    }

    return this.runtime.coordinator.run({
      taskKind: 'detail_fill',
      messages: [taskMessage],
      scope,
      resourceScope: { sceneId, format },
      maxOutputTokens: getSettings().maxOutputTokens,
      signal,
      onChunk: hooks.onChunk,
      onReasoning: hooks.onReasoning,
      onSearchStatus: hooks.onSearchStatus,
      onToolTrace: hooks.onToolTrace,
    });
    } finally {
      this.runActive = false;
    }
  }

  /** 刷新：对最后一条 AI 消息重新生成，旧回复保留为兄弟分支（§3.2）。归档会话完全只读（ux-review §4.5）。 */
  async refreshMessage(messageId: string, hooks: AppRunHooks = {}, answerDetail?: 'concise' | 'auto' | 'detailed'): Promise<RunResult> {
    if (this.runActive) throw new Error('RUN_ALREADY_ACTIVE: 已有任务在运行，请先等待完成或取消');
    this.runActive = true;
    try {
    if (this.isActiveSessionArchived()) throw new Error('SESSION_ARCHIVED');
    const conv = this.workspace.conversation;
    const target = conv.getMessage(messageId);
    if (!target) throw new Error(`MESSAGE_NOT_FOUND: ${messageId}`);
    if (target.role !== 'ai') throw new Error('REFRESH_NOT_AI_MESSAGE');
    const parentId = target.parentId;
    // 上下文 = 父消息之前的活动路径（不含被取代的旧回答）
    const context: ChatMessage[] = [];
    if (parentId) {
      const messages = conv.readMessagesWithTree();
      const byId = new Map(messages.map((m) => [m.id, m]));
      let current = byId.get(parentId);
      const reversed: ChatMessage[] = [];
      while (current) {
        reversed.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      context.push(...reversed);
    }
    if (!this.runtime) throw new Error('NO_PROJECT_OPEN');
    // 刷新同样走压缩组装（§7.2）；Part 5：附件正文先内联
    const ctx = await this.prepareChatContext(this.prepareModelMessages(context));
    if (ctx.eventText) this.appendSystemEvent(ctx.eventText, context.at(-1)?.id);
    else if (ctx.failureText) this.appendSystemEvent(ctx.failureText, context.at(-1)?.id);
    return this.runtime.coordinator.run({
      taskKind: 'chat',
      messages: ctx.messages,
      parentMessageId: parentId,
      supersedesMessageId: messageId,
      contextInfo: ctx.contextInfo,
      maxOutputTokens: getSettings().maxOutputTokens,
      // 重新生成使用当前选择器档位（用户可先调档位再重新生成）
      answerDetail,
      onChunk: hooks.onChunk,
      onReasoning: hooks.onReasoning,
      onSearchStatus: hooks.onSearchStatus,
      onToolTrace: hooks.onToolTrace,
    });
    } finally {
      this.runActive = false;
    }
  }

  // -------------------------------------------------------------- 就地改写（revise，ux-review §5.3）

  /**
   * 启动就地改写 run（仅限正文，§5.3）：
   * - 只读白名单（可见视图 / 设定 / 当前输出），无写入工具；
   * - 模型最终回答 = 选中区间的完整替换文本（空 = 删除），替换在「接受」时本地执行；
   * - 任务消息：选中区间 + 前后文（各 30 行）+ 修改指令。
   */
  async runRevise(
    sceneId: string,
    format: string,
    start: number,
    end: number,
    instruction: string,
    hooks: AppRunHooks = {},
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (this.runActive) throw new Error('RUN_ALREADY_ACTIVE: 已有任务在运行，请先等待完成或取消');
    this.runActive = true;
    try {
    const ws = this.workspace;
    if (!this.runtime) throw new Error('NO_PROJECT_OPEN');
    const node = ws.outline.findNode(sceneId);
    if (!node) throw new Error(`NODE_NOT_FOUND: ${sceneId}`);
    if (node.type !== 'scene') throw new Error(`NOT_SCENE_NODE: ${sceneId}`);
    if (!ws.outputs.exists(sceneId, format)) throw new Error('OUTPUT_NOT_FOUND：请先生成正文');

    const content = ws.outputs.read(sceneId, format);
    if (start < 0 || end > content.length || start > end) throw new Error('INVALID_RANGE');

    // 前后文（各取选中区间前后最多 1200 字，帮助模型保持文风）
    const beforeText = content.slice(Math.max(0, start - 1200), start);
    const afterText = content.slice(end, Math.min(content.length, end + 1200));
    const selected = content.slice(start, end);

    const taskMessage: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content: [
        `场景：${node.title}（${format}格式）`,
        `修改指令：${instruction}`,
        '',
        `选中区间之前的正文（约 ${beforeText.length} 字）：`,
        beforeText,
        '',
        `【选中区间】（约 ${selected.length} 字）：`,
        selected,
        '',
        `选中区间之后的正文（约 ${afterText.length} 字）：`,
        afterText,
        '',
        '只返回「选中区间的完整替换文本」本身。',
      ].join('\n'),
      timestamp: new Date().toISOString(),
    };

    return this.runtime.coordinator.run({
      taskKind: 'revise',
      messages: [taskMessage],
      scope: `就地改写：${node.title} · ${format}（${instruction.slice(0, 40)}）`,
      resourceScope: { sceneId, format },
      maxOutputTokens: getSettings().maxOutputTokens,
      signal,
      onChunk: hooks.onChunk,
      onReasoning: hooks.onReasoning,
      onSearchStatus: hooks.onSearchStatus,
      onToolTrace: hooks.onToolTrace,
    });
    } finally {
      this.runActive = false;
    }
  }

  /**
   * 接受改写（§5.3）：替换 = 新文本替换原选区（确定性，无 diff 匹配），
   * 写入前自动快照（单级撤销）。沙箱隔离：不产生任何对话消息。
   */
  applyRevise(sceneId: string, format: string, start: number, end: number, replacement: string): ProjectState {
    const ws = this.workspace;
    if (!ws.outline.findNode(sceneId)) throw new Error(`NODE_NOT_FOUND: ${sceneId}`);
    if (!ws.outputs.exists(sceneId, format)) throw new Error('OUTPUT_NOT_FOUND');
    const content = ws.outputs.read(sceneId, format);
    if (start < 0 || end > content.length || start > end) throw new Error('INVALID_RANGE');

    const outputFile = path.join(ws.dir, 'outputs', `${assertSafeId(sceneId, 'scene')}.${assertSafeFormat(format)}.md`);
    const snapshotId = `revise-${Date.now()}`;
    ws.snapshots.createSnapshot(snapshotId, [outputFile]);

    const next = content.slice(0, start) + replacement + content.slice(end);
    const view = ws.visibleViews.read(sceneId);
    ws.outputs.write(sceneId, format, next, view ? sha256(view.content) : '');
    // 单级撤销标记（复用 snapshots；快照目录很小）
    const undoMarker = path.join(ws.dir, 'outputs', '.revise-undo.json');
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(undoMarker, JSON.stringify({ sceneId, format, snapshotId, at: new Date().toISOString() }), 'utf-8');
    // 沙箱隔离（ux-review §5.2 修订）：改写结果只在正文模块内呈现，不产生任何对话消息
    return this.getState();
  }

  /** 撤销上次改写（§5.3：单级；多级由版本历史兜底）。 */
  undoRevise(sceneId: string, format: string): ProjectState {
    const ws = this.workspace;
    const fs = require('fs') as typeof import('fs');
    const markerFile = path.join(ws.dir, 'outputs', '.revise-undo.json');
    interface ReviseMarker { sceneId: string; format: string; snapshotId: string }
    let marker: ReviseMarker | null = null;
    try {
      if (!fs.existsSync(markerFile)) return this.getState();
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf-8')) as ReviseMarker;
    } catch {
      return this.getState();
    }
    if (!marker || marker.sceneId !== sceneId || marker.format !== format) return this.getState();
    try {
      ws.snapshots.restoreSnapshot(marker.snapshotId);
      fs.rmSync(markerFile, { force: true });
    } catch (err) {
      throw new Error(`UNDO_FAILED: ${(err as Error).message}`);
    }
    return this.getState();
  }

  // -------------------------------------------------------------- 版本历史

  /** 节点版本历史（§5.5：提交/运行快照中该节点正式版文件的清单）。 */
  listNodeVersions(nodeId: string): Array<{ snapshotId: string; createdAt: string; hash: string }> {
    return this.workspace.snapshots.listNodeVersions(nodeId);
  }

  /** 读取某版本快照中的节点正式版内容。 */
  readNodeVersion(nodeId: string, snapshotId: string): string {
    const content = this.workspace.snapshots.readNodeVersion(nodeId, snapshotId);
    if (content === null) throw new Error(`VERSION_NOT_FOUND: ${snapshotId}`);
    return content;
  }

  // -------------------------------------------------------------- 摘要/回滚

  listRuns(): Array<import('../shared/ipc-types').RunSummaryEntry> {
    return AppService.collectRunSummaries(this.workspace);
  }

  /** 读取一次 run 的调用详情（ux-review §4.7）；不存在返回 null。 */
  inspectRun(runId: string): import('../shared/types').RunRecord | null {
    return readRunRecord(this.workspace, runId);
  }

  /**
   * 变更摘要的文件级 diff（§5.4）：快照（写前）vs 当前（写后）。
   * 只比较 nodes/ 与 world/ 下的 markdown 文件；结构变更由结构操作列表表达。
   * 覆盖三类：修改（快照与当前都在）、新建（快照不存在）、删除（当前不存在）。
   */
  runDiff(runId: string): Array<{ path: string; before: string | null; after: string | null }> {
    const ws = this.workspace;
    const fs = require('fs') as typeof import('fs');
    const manifest = ws.snapshots.readManifest(runId);
    if (!manifest) throw new Error(`SNAPSHOT_NOT_FOUND: ${runId}`);
    const out: Array<{ path: string; before: string | null; after: string | null }> = [];
    const seen = new Set<string>();

    const readFile = (file: string): string | null => {
      try {
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
      } catch {
        return null;
      }
    };

    // 1) 快照中的文件（修改 / 删除）
    for (const rel of manifest.files) {
      if (!/^(nodes|world)\/.*\.md$/.test(rel)) continue;
      seen.add(rel);
      const before = readFile(path.join(ws.dir, 'snapshots', runId, ...rel.split('/')));
      const after = readFile(path.join(ws.dir, ...rel.split('/')));
      if (before === after) continue;
      out.push({ path: rel, before, after });
    }

    // 2) 运行期间新建的文件：覆盖目录中、快照时刻不存在的 .md（node_created / asset_created）
    const scan = (dir: string): string[] => {
      const fullDir = path.join(ws.dir, dir);
      const result: string[] = [];
      try {
        for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            result.push(...scan(`${dir}/${entry.name}`));
          } else if (entry.name.endsWith('.md')) {
            result.push(`${dir}/${entry.name}`);
          }
        }
      } catch {
        /* 目录不存在 */
      }
      return result;
    };
    const preExisting = new Set(manifest.preExistingFiles ?? []);
    for (const dir of (manifest.dirs ?? []).filter((d) => d === 'nodes' || d === 'world')) {
      for (const rel of scan(dir)) {
        if (preExisting.has(rel) || seen.has(rel)) continue;
        const after = readFile(path.join(ws.dir, ...rel.split('/')));
        if (after !== null) out.push({ path: rel, before: null, after });
      }
    }
    return out;
  }

  acceptRun(runId: string): ProjectState {
    acceptRun(this.workspace, runId);
    return this.getState();
  }

  rollbackRun(runId: string): ProjectState {
    rollbackRun(this.workspace, runId);
    return this.getState();
  }

  // -------------------------------------------------------------- 设置

  setApiKey(key: string): ProjectState {
    if (!key || key.trim() === '') throw new Error('EMPTY_API_KEY');
    saveApiKey('deepseek', key.trim());
    return this.getState();
  }

  /** 更新全局设置（模型 / 思考模式 / 思考强度 / 主题，DeepSeek V4）。
   * 无项目打开时（项目首页换主题）返回 null——设置是全局的，与项目无关。
   * 注意：不能用 this.workspace 判空（getter 无项目时抛 NO_PROJECT_OPEN）。 */
  updateSettings(partial: Partial<AppSettings>): ProjectState | null {
    saveSettings(partial);
    return this.runtime ? this.getState() : null;
  }

  /** 全局设置快照（无项目打开时也可用：启动首帧主题校正）。 */
  getAppSettings(): AppSettings {
    return getSettings();
  }

  hasApiKeyConfigured(): boolean {
    return hasApiKey('deepseek');
  }
}

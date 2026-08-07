/**
 * App.tsx — 顶层形态（ux-review §2）。
 *
 * ┌────────────────────────────────────────────────┐
 * │ 顶部栏：项目名    [情节讨论] [正文写作]    ⚙      │
 * ├────────────────────────────────────────────────┤
 * │  讨论模块（全屏，独占界面）                       │
 * │  正文模块（全屏，独占界面，tab 切换进入）          │
 * └────────────────────────────────────────────────┘
 *
 * - 「情节讨论」「正文写作」是对等的一等公民模块，各自占满整个窗口，顶部 tab 切换；
 * - 模块 UI 状态互相独立：讨论模块的选中节点、正文模块的选中场景互不干扰，
 *   切换 tab 不丢状态（两模块同时挂载，display 切换）；
 * - 设置 = 顶部齿轮，弹窗（模态对话框）。
 */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { store, useStore, type ModuleId } from './store';
import { getApi } from './api';
import { confirmDialog } from './components/ui/dialog';
import { LeftPanel } from './components/LeftPanel';
import { ConversationPane } from './components/ConversationPane';
import { Workspace } from './components/Workspace';
import { WritingModule } from './components/WritingModule';
import { SettingsDialog } from './components/ui/SettingsDialog';
import { DialogHost } from './components/ui/dialog';
import './styles.css';

const MIN_LEFT = 180;
const MAX_LEFT = 480;
const MIN_RIGHT = 240;
const MAX_RIGHT = 560;

function loadWidth(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function ProjectScreen(): React.ReactElement {
  const projects = useStore((s) => s.projects);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  useEffect(() => {
    void store.loadProjects().catch((err) => store.showToast((err as Error).message, 'error'));
  }, []);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await store.createProject(name.trim());
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (dir: string, projectName: string): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除项目「${projectName}」？`,
      message: '项目文件夹将移到系统回收站（可恢复）。若正在打开，会自动关闭并回到项目列表。',
      confirmText: '移到回收站',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await store.deleteProject(dir);
      store.showToast('项目已移到系统回收站', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-screen">
      <h1>故事工坊</h1>
      <p className="subtitle">大模型辅助故事创作：讨论 → 整理 → 细纲 → 可见视图 → 正文</p>

      <div className="project-form">
        <input
          data-testid="project-name"
          placeholder="项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
        />
        <button data-testid="project-create" className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
          创建项目
        </button>
        <button className="small-btn" onClick={() => void store.pickAndOpen()}>打开文件夹…</button>
      </div>

      {projects.length > 0 && (
        <div className="project-list">
          <h3>最近项目</h3>
          {projects.map((p) => (
            <div key={p.dir} className="project-item">
              <button className="project-item-main" onClick={() => void store.openProject(p.dir)}>
                <span>{p.name}</span>
                <span className="muted small">{new Date(p.createdAt).toLocaleString()}</span>
              </button>
              <button
                className="tiny-btn project-item-delete"
                disabled={busy}
                title="删除项目（移到系统回收站，可恢复）"
                onClick={() => void remove(p.dir, p.name)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 顶部栏（ux-review §2）：项目名 + 模块 tab + 设置齿轮弹窗。 */
function TopBar(): React.ReactElement {
  const project = useStore((s) => s.project);
  const module = useStore((s) => s.module);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const MODULES: Array<{ id: ModuleId; label: string }> = [
    { id: 'discussion', label: '情节讨论' },
    { id: 'writing', label: '正文写作' },
  ];

  return (
    <div className="topbar">
      <span className="topbar-project">{project?.name ?? ''}</span>
      <div className="topbar-tabs">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={module === m.id ? 'tab active' : 'tab'}
            onClick={() => store.setModule(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <button className="tiny-btn" onClick={() => setSettingsOpen(true)} title="设置（弹窗）">⚙</button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function App(): React.ReactElement {
  const project = useStore((s) => s.project);
  const toast = useStore((s) => s.toast);
  const module = useStore((s) => s.module);
  const [cols, setCols] = React.useState({ left: 250, right: 340 });
  const colsRef = React.useRef(cols);
  colsRef.current = cols;

  useEffect(() => {
    setCols({ left: loadWidth('sw2:col-left', 250), right: loadWidth('sw2:col-right', 340) });
  }, []);

  // 订阅主进程 run 流式事件
  useEffect(() => {
    const off = getApi().run.onEvent((event) => store.applyRunEvent(event));
    return off;
  }, []);

  const startDrag = (side: 'left' | 'right', e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const start = colsRef.current;
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      if (side === 'left') {
        setCols({ ...colsRef.current, left: clamp(start.left + dx, MIN_LEFT, MAX_LEFT) });
      } else {
        setCols({ ...colsRef.current, right: clamp(start.right - dx, MIN_RIGHT, MAX_RIGHT) });
      }
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('sw2:col-left', String(colsRef.current.left));
      localStorage.setItem('sw2:col-right', String(colsRef.current.right));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="app">
      {!project ? (
        <ProjectScreen />
      ) : (
        <div className="app-shell">
          <TopBar />
          <div className="app-modules">
            {/* 讨论模块：三栏（大纲|设定|会话 + 对话 + 右栏对象详情） */}
            <div
              className="discussion-module"
              style={{ display: module === 'discussion' ? undefined : 'none' }}
            >
              <div
                className="layout"
                style={{ '--col-left': `${cols.left}px`, '--col-right': `${cols.right}px` } as React.CSSProperties}
              >
                <div className="splitter" style={{ left: `calc(${cols.left}px - 3px)` }} onMouseDown={(e) => startDrag('left', e)} />
                <LeftPanel />
                <ConversationPane />
                <Workspace />
                <div
                  className="splitter"
                  style={{ left: `calc(100% - ${cols.right}px - 3px)` }}
                  onMouseDown={(e) => startDrag('right', e)}
                />
              </div>
            </div>
            {/* 正文模块：场景树 + 可见视图 + 正文工作区 */}
            <div
              className="writing-module-host"
              style={{ display: module === 'writing' ? undefined : 'none' }}
            >
              <WritingModule />
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
      <DialogHost />
    </div>
  );
}

export { App, ProjectScreen };

/**
 * ErrorBoundary.tsx — 顶层错误边界（ux-review §6.11）：preload/渲染异常时
 * 不整窗白屏，显示恢复页（重新加载）。
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>界面出错了</h1>
          <p className="muted">应用遇到未预期错误，你的项目文件不受影响（内容已落盘在项目目录）。</p>
          <pre className="error-boundary-detail">{String(this.state.error.message || this.state.error)}</pre>
          <div className="row">
            <button className="primary" onClick={() => window.location.reload()}>重新加载</button>
            <button className="small-btn" onClick={() => this.setState({ error: null })}>尝试继续</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

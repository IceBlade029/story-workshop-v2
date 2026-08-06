/**
 * entry.tsx — 渲染层入口：挂载 App 到 #root。
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}

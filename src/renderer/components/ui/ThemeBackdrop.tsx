import React from 'react';

/**
 * 主题装饰层。
 *
 * 只提供稳定、无语义的装饰挂点；具体图案完全由 data-theme 控制。
 * 默认主题隐藏本层，其他主题使用纯 CSS 绘制星轨、纸纹、花瓣与藤蔓。
 */
export function ThemeBackdrop(): React.ReactElement {
  return (
    <div className="theme-backdrop" aria-hidden="true">
      <span className="theme-ornament theme-ornament-a" />
      <span className="theme-ornament theme-ornament-b" />
      <span className="theme-ornament theme-ornament-c" />
    </div>
  );
}

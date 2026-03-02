import React from 'react';

/**
 * ErrorBoundary — 捕获子组件树的运行时渲染错误，防止整个应用白屏。
 *
 * 用法：
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 * 可选 prop:
 *   - fallback: 自定义错误 UI (ReactNode 或 (error, reset) => ReactNode)
 *   - onError: 错误回调 (日志上报等)
 */

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 自定义错误 UI。可以是静态节点或渲染函数。 */
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
  /** 错误发生时的回调 (可用于日志上报) */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
    // 同时输出到 console 方便开发调试
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      // 自定义 fallback
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.handleReset);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 默认错误 UI
      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-lg font-semibold text-red-400 mb-2">
            组件渲染出错
          </h2>
          <p className="text-sm text-zinc-400 mb-4 max-w-md font-mono break-all">
            {this.state.error.message}
          </p>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg
                       text-sm transition-colors cursor-pointer"
          >
            重试
          </button>
          <details className="mt-4 text-left max-w-lg w-full">
            <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
              错误详情
            </summary>
            <pre className="mt-2 p-3 bg-zinc-900 rounded text-xs text-zinc-400 overflow-auto max-h-48">
              {this.state.error.stack}
            </pre>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

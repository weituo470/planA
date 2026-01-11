import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'reactflow/dist/style.css';
import './styles.css';

import { getTestSessionId, postTestLogEvent } from './lib/test-logger';

declare global {
  interface Window {
    __mvp5TestLogInstalled?: boolean;
  }
}

function truncateText(value: unknown, max = 1200) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(truncated)`;
}

function safeSerializeReason(reason: unknown) {
  if (!reason) return null;
  if (typeof reason === 'string') return truncateText(reason);
  if (typeof reason === 'object') {
    const anyReason = reason as any;
    const message = typeof anyReason.message === 'string' ? anyReason.message : '';
    const name = typeof anyReason.name === 'string' ? anyReason.name : '';
    const stack = typeof anyReason.stack === 'string' ? anyReason.stack : '';
    return {
      name: name || undefined,
      message: message ? truncateText(message) : undefined,
      stack: stack ? truncateText(stack, 5000) : undefined,
    };
  }
  return truncateText(String(reason));
}

if (typeof window !== 'undefined' && !window.__mvp5TestLogInstalled) {
  window.__mvp5TestLogInstalled = true;

  void postTestLogEvent({
    level: 'info',
    source: 'dashboard',
    action: 'app.boot',
    message: 'dashboard boot',
    data: { sessionId: getTestSessionId(), href: window.location.href },
  }).catch((e: any) => console.error('[testlog] app.boot failed', e));

  window.addEventListener('error', (event) => {
    try {
      const payload = {
        sessionId: getTestSessionId(),
        message: truncateText((event as any)?.message || 'window.error'),
        filename: (event as any)?.filename ? String((event as any).filename) : undefined,
        lineno: Number.isFinite((event as any)?.lineno) ? (event as any).lineno : undefined,
        colno: Number.isFinite((event as any)?.colno) ? (event as any).colno : undefined,
        error: safeSerializeReason((event as any)?.error),
      };
      void postTestLogEvent({
        level: 'error',
        source: 'dashboard',
        action: 'window.error',
        message: payload.message,
        data: payload,
      }).catch((e: any) => console.error('[testlog] window.error failed', e));
    } catch (e: any) {
      console.error('[testlog] window.error handler failed', e);
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const payload = {
        sessionId: getTestSessionId(),
        reason: safeSerializeReason((event as any)?.reason),
      };
      void postTestLogEvent({
        level: 'error',
        source: 'dashboard',
        action: 'window.unhandledrejection',
        message: 'Unhandled promise rejection',
        data: payload,
      }).catch((e: any) => console.error('[testlog] window.unhandledrejection failed', e));
    } catch (e: any) {
      console.error('[testlog] window.unhandledrejection handler failed', e);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

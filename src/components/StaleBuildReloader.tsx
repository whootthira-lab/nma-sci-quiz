'use client';

import { useEffect } from 'react';

/**
 * A tab that outlives a deploy holds HTML pointing at chunk files the new build has
 * replaced, so the next click that lazy-loads one fails and the page just goes dead —
 * which users can only describe as "กดแล้วไม่มีอะไรเกิดขึ้น". The fix is a refresh they
 * don't know to do; this does it for them, once, the moment a stale chunk is detected.
 * The once-flag clears on the next successful load, and a genuinely broken build only
 * reloads a single time instead of looping.
 */
export default function StaleBuildReloader() {
  useEffect(() => {
    const KEY = 'stale_build_reloaded';
    try {
      sessionStorage.removeItem(KEY); // this load succeeded; re-arm
    } catch { /* storage unavailable — guard degrades to doing nothing */ }

    const isChunkFailure = (msg: string) =>
      /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(msg);

    const reloadOnce = () => {
      try {
        if (sessionStorage.getItem(KEY)) return;
        sessionStorage.setItem(KEY, '1');
      } catch { return; }
      window.location.reload();
    };

    const onError = (e: ErrorEvent) => {
      if (isChunkFailure(String(e.message || ''))) reloadOnce();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      if (isChunkFailure(String(r?.message || r || ''))) reloadOnce();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}

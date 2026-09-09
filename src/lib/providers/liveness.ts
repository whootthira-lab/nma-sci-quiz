import { falKey, baseAppId } from './fal';

/**
 * Is a Fal endpoint still there? (Film F5 — pinning must come with a liveness check: Fal
 * removes and re-paths models without notice, e.g. `fal-ai/flux/dev/fill` vanished.)
 *
 * The queue ACCEPTS any path under a known app, so acceptance proves nothing. What does:
 * an empty-body submit finishes at once, and the result is
 *   422 validation error ("Field required")   → the app is live and validating input
 *   404 "Path /x/y not found" / "Application not found" → gone
 * Measured 10 ก.ย.: veed/bria → 422, flux/dev/fill → 404 "Path /dev/fill not found",
 * bogus app → 404 at submit. No compute runs, so nothing is billed.
 */
export type Liveness = { alive: boolean | null; detail: string; ms: number };

export async function probeEndpoint(endpoint: string, timeoutMs = 20000): Promise<Liveness> {
  const key = falKey();
  const t0 = Date.now();
  if (!key) return { alive: null, detail: 'no FAL key', ms: 0 };
  const H = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  try {
    const sub = await fetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', headers: H, body: '{}' });
    const subText = await sub.text();
    if (sub.status === 404) return { alive: false, detail: subText.slice(0, 160), ms: Date.now() - t0 };
    if (sub.status === 401 || sub.status === 403) return { alive: null, detail: `auth ${sub.status}`, ms: Date.now() - t0 };
    if (sub.status === 422) return { alive: true, detail: 'validates input', ms: Date.now() - t0 };
    let id = '';
    try { id = JSON.parse(subText).request_id || ''; } catch { /* not json */ }
    if (!id) return { alive: null, detail: `submit ${sub.status}: ${subText.slice(0, 120)}`, ms: Date.now() - t0 };
    const base = baseAppId(endpoint);
    while (Date.now() - t0 < timeoutMs) {
      const st = await fetch(`https://queue.fal.run/${base}/requests/${id}/status`, { headers: H });
      const sj: any = await st.json().catch(() => ({}));
      if (sj.status === 'COMPLETED' || st.status === 400 || st.status === 422) {
        const res = await fetch(`https://queue.fal.run/${base}/requests/${id}`, { headers: H });
        const text = await res.text();
        if (res.status === 422) return { alive: true, detail: 'validates input', ms: Date.now() - t0 };
        if (res.status === 404) return { alive: false, detail: text.slice(0, 160), ms: Date.now() - t0 };
        return { alive: null, detail: `result ${res.status}: ${text.slice(0, 120)}`, ms: Date.now() - t0 };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { alive: null, detail: 'timeout', ms: Date.now() - t0 };
  } catch (e: any) {
    return { alive: null, detail: e?.message || String(e), ms: Date.now() - t0 };
  }
}

/**
 * The one door to Fal. Every route used to open its own — five copies of the queue URL
 * rule, four copies of the error parser — and every hard-won fact about how Fal actually
 * behaves lived in exactly one of them. They live here now:
 *
 *  - The queue is addressed by APPLICATION id, never by the sub-path a job was submitted
 *    to (`fal-ai/flux/schnell` polls at `fal-ai/flux/requests/…`). Polling the sub-path
 *    answers 405, which routes used to report as "still waiting" — forever.
 *  - The queue accepts ANY path and hands back a request id; a model that does not exist
 *    only fails when the result is fetched (`Path /dev/fill not found`). Acceptance into
 *    the queue proves nothing. Only a fetched result does.
 *  - A refused submit names its reason in `detail`, as a string or a validator array.
 *    Relaying it beats "sending failed".
 */

export type FalStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | string;

export function falKey(): string {
  return process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY || '';
}

/** `owner/app` — the first two path segments, always. */
export function baseAppId(endpoint: string): string {
  const parts = (endpoint || '').split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(0, 2).join('/');
}

/** Turn a refused response body into one readable line. */
export function parseFalError(text: string, max = 200): string {
  let why = (text || '').slice(0, max);
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail;
    if (typeof detail === 'string') why = detail.slice(0, max);
    else if (Array.isArray(detail)) {
      why = detail
        .map((d: any) => `${(d.loc || []).filter((p: any) => p !== 'body').join('.')}: ${d.msg}`)
        .join(' | ')
        .slice(0, max);
    }
  } catch { /* keep raw text */ }
  return why;
}

export class FalSubmitError extends Error {
  httpStatus: number;
  detail: string;
  constructor(httpStatus: number, detail: string) {
    super(detail);
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
  /** The provider locked the account — money, not code. */
  get isBalanceLock() {
    return /exhausted balance|user is locked/i.test(this.detail);
  }
}

export interface FalSubmitResult {
  requestId: string;
  raw: any;
}

/** Queue a job. Throws FalSubmitError with the provider's own reason on refusal. */
export async function falSubmit(
  endpoint: string,
  body: Record<string, any>,
  opts: { timeoutMs?: number } = {}
): Promise<FalSubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey()}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Fal Submit ${endpoint}]`, res.status, text.slice(0, 300));
    throw new FalSubmitError(res.status, parseFalError(text));
  }
  const raw = await res.json();
  if (!raw?.request_id) {
    throw new FalSubmitError(200, `queue answered without a request id: ${JSON.stringify(raw).slice(0, 120)}`);
  }
  return { requestId: raw.request_id, raw };
}

export interface FalStatusResult {
  ok: boolean;
  httpStatus: number;
  status: FalStatus | '';
  data: any;
}

/** Poll a job. Never throws on HTTP failure — the caller decides WAITING vs ERROR. */
export async function falStatus(endpoint: string, requestId: string): Promise<FalStatusResult> {
  const res = await fetch(`https://queue.fal.run/${baseAppId(endpoint)}/requests/${requestId}/status`, {
    headers: { 'Authorization': `Key ${falKey()}`, 'Accept': 'application/json' },
    cache: 'no-store'
  });
  if (!res.ok) return { ok: false, httpStatus: res.status, status: '', data: null };
  const data = await res.json();
  return { ok: true, httpStatus: res.status, status: data?.status || '', data };
}

export interface FalResultFetch {
  ok: boolean;
  httpStatus: number;
  data: any;
  text: string;
}

/** Fetch a completed job's output. `url` may override with Fal's own response_url. */
export async function falResult(endpoint: string, requestId: string, url?: string): Promise<FalResultFetch> {
  const res = await fetch(url || `https://queue.fal.run/${baseAppId(endpoint)}/requests/${requestId}`, {
    headers: { 'Authorization': `Key ${falKey()}`, 'Accept': 'application/json' },
    cache: 'no-store'
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, httpStatus: res.status, data, text };
}

/** Every model names its output differently; callers want one URL and one kind. */
export function normalizeOutput(data: any): { url: string; kind: 'video' | 'image' | 'audio' | null } {
  if (!data) return { url: '', kind: null };
  const video = data.video?.url || data.output?.video?.url;
  if (video) return { url: video, kind: 'video' };
  const image = data.images?.[0]?.url || data.image?.url;
  if (image) return { url: image, kind: 'image' };
  const audio = data.audio?.url || data.audio_file?.url;
  if (audio) return { url: audio, kind: 'audio' };
  return { url: '', kind: null };
}

/**
 * Response-shaped submit for routes written against `fetch` — lets the call sites move
 * onto the adapter without rewriting their `.ok / .status / .json() / .text()` handling.
 * Refusals surface as ok:false with the provider's parsed reason in text().
 */
export async function falSubmitCompat(endpoint: string, body: Record<string, any>, timeoutMs = 20000) {
  try {
    const r = await falSubmit(endpoint, body, { timeoutMs });
    return { ok: true, status: 200, json: async () => r.raw, text: async () => JSON.stringify(r.raw) };
  } catch (e: any) {
    const status = e instanceof FalSubmitError ? e.httpStatus : 500;
    const detail = e instanceof FalSubmitError ? e.detail : (e?.message || 'submit failed');
    return { ok: false, status, json: async () => ({ detail }), text: async () => JSON.stringify({ detail }) };
  }
}

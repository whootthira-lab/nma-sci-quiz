import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash, createPublicKey, verify as edVerify } from 'crypto';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Fal queue webhook. Fal POSTs here when a job we submitted with `fal_webhook` finishes.
 *
 * Trust model: the body is NOT used as data. We verify Fal's ED25519 signature (JWKS at
 * rest.alpha.fal.ai), find which generation row the request id belongs to, and run the
 * existing completion path by calling /api/video-status for that row — which fetches the
 * status and result from Fal itself. An unverified or unknown callback is ignored (200,
 * so Fal stops retrying); the browser poll and the 5-minute cron driver remain as fallback.
 *
 * Headers (per Fal): X-Fal-Webhook-Request-Id, X-Fal-Webhook-User-Id,
 * X-Fal-Webhook-Timestamp, X-Fal-Webhook-Signature (hex). Signed message =
 * "<request_id>\n<user_id>\n<timestamp>\n<sha256hex(body)>".
 */
const JWKS_URL = 'https://rest.alpha.fal.ai/.well-known/jwks.json';
let jwksCache: { keys: any[]; at: number } = { keys: [], at: 0 };

async function jwks(): Promise<any[]> {
  if (jwksCache.keys.length && Date.now() - jwksCache.at < 12 * 60 * 60 * 1000) return jwksCache.keys;
  try {
    const j = await fetch(JWKS_URL, { cache: 'no-store' }).then((r) => r.json());
    jwksCache = { keys: Array.isArray(j?.keys) ? j.keys : [], at: Date.now() };
  } catch { /* keep old */ }
  return jwksCache.keys;
}

async function verifySignature(req: NextRequest, rawBody: string): Promise<{ ok: boolean; why: string }> {
  const requestId = req.headers.get('x-fal-webhook-request-id') || '';
  const userId = req.headers.get('x-fal-webhook-user-id') || '';
  const ts = req.headers.get('x-fal-webhook-timestamp') || '';
  const sigHex = req.headers.get('x-fal-webhook-signature') || '';
  if (!requestId || !userId || !ts || !sigHex) return { ok: false, why: 'missing headers' };
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 300) return { ok: false, why: 'timestamp outside 5 min' };
  const digest = createHash('sha256').update(rawBody).digest('hex');
  const message = Buffer.from(`${requestId}\n${userId}\n${ts}\n${digest}`);
  const sig = Buffer.from(sigHex, 'hex');
  for (const k of await jwks()) {
    try {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(k.x).replace(/=+$/, '') }, format: 'jwk' });
      if (edVerify(null, message, key, sig)) return { ok: true, why: `kid ${k.kid}` };
    } catch { /* try next key */ }
  }
  return { ok: false, why: 'no key verified the signature' };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { /* unreadable body still gets a 200 below */ }
  const requestId = String(payload?.request_id || req.headers.get('x-fal-webhook-request-id') || '');
  const sig = await verifySignature(req, raw);
  if (!sig.ok) {
    console.warn(`[fal webhook] unverified callback ignored (${sig.why}) request=${requestId}`);
    return NextResponse.json({ ok: true, ignored: 'unverified' });
  }
  if (!requestId) return NextResponse.json({ ok: true, ignored: 'no request id' });

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  const sb = createClient(url, key);

  // The row this job belongs to: the base job, or one of the follow-up phases stored in metadata
  let row: any = null;
  const direct = await sb.from('generations').select('id, fal_request_id, status, metadata').eq('fal_request_id', requestId).maybeSingle();
  row = direct.data;
  if (!row) {
    for (const field of ['lipsync_request_id', 'ambient_request_id', 'face_restore_request_id']) {
      const r = await sb.from('generations').select('id, fal_request_id, status, metadata').eq(`metadata->>${field}`, requestId).maybeSingle();
      if (r.data) { row = r.data; break; }
    }
  }
  if (!row) {
    console.log(`[fal webhook] request ${requestId} not ours (or already cleaned up) — ignored`);
    return NextResponse.json({ ok: true, ignored: 'unknown request' });
  }
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'removed') {
    return NextResponse.json({ ok: true, ignored: `row already ${row.status}` });
  }

  // Same completion path the browser and the cron driver use; idempotent on repeats.
  const videoPath = row.metadata?.storage_path || `videos/${row.metadata?.user_email || 'unknown'}/${Date.now()}_output.mp4`;
  try {
    const res = await fetch(`${req.nextUrl.origin}/api/video-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: row.fal_request_id, videoPath, storageProvider: row.metadata?.storage_provider || 'supabase', modelEndpoint: row.metadata?.model_endpoint })
    });
    const j = await res.json().catch(() => ({}));
    console.log(`[fal webhook] ${payload?.status || '?'} request=${requestId} → video-status ${res.status} ${j?.status || ''} (${sig.why})`);
    return NextResponse.json({ ok: true, driven: true, result: j?.status || null });
  } catch (e: any) {
    console.error('[fal webhook] drive failed:', e?.message || e);
    return NextResponse.json({ ok: true, driven: false });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * The server-side job driver (Prereq A of the VFX spec, and the cure for a real wound):
 * every phase of a generation used to be advanced only by the browser of whoever clicked
 * สร้าง — switch pages or close the tab and the job hangs forever, even when the model
 * finished long ago. This sweep finds generations still marked "processing" and knocks on
 * /api/video-status for each, which is the exact phase logic the browser would have run:
 * idempotent by design (WAITING is a no-op, phase submits are guarded by their stored
 * request ids, completion uploads are upserts), so the browser and this sweep can poll
 * the same job without stepping on each other.
 *
 * A browser that IS still watching stays the faster driver; this is the safety net that
 * makes "กดสร้างแล้วปิดแท็บได้เลย" true.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> when the env var is set.
  // With no secret configured the endpoint stays open — it can only advance legitimate
  // stuck jobs, and every action it takes is one the owner's browser could have taken.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  const supabase = createClient(supabaseUrl, supabaseKey);

  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const graceAgo = new Date(now - 2 * 60 * 1000).toISOString();

  // A day-old "processing" is not processing — say so instead of spinning forever
  await supabase
    .from('generations')
    .update({ status: 'failed', error_message: 'งานค้างเกิน 24 ชั่วโมง ระบบปิดงานอัตโนมัติ' })
    .eq('status', 'processing')
    .lt('created_at', dayAgo);

  // Oldest-forgotten first; the two-minute grace keeps freshly submitted jobs with the
  // browser that submitted them, narrowing the double-driver window on phase handoffs.
  const { data: stuck, error } = await supabase
    .from('generations')
    .select('id, fal_request_id, metadata, created_at')
    .eq('status', 'processing')
    .gte('created_at', dayAgo)
    .lt('created_at', graceAgo)
    .order('updated_at', { ascending: true })
    .limit(4);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!stuck || stuck.length === 0) {
    return NextResponse.json({ ok: true, driven: 0 });
  }

  // Call back through the PUBLIC host the request arrived on. The deployment-specific
  // VERCEL_URL sits behind Vercel's deployment protection and answers 401 to itself.
  const origin = process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;

  const results = await Promise.allSettled(
    stuck
      .filter((row) => row.fal_request_id && row.metadata?.storage_path)
      .map(async (row) => {
        const res = await fetch(`${origin}/api/video-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: row.fal_request_id,
            videoPath: row.metadata.storage_path,
            modelType: row.metadata.model_name || '',
            modelEndpoint: row.metadata.model_endpoint || '',
            storageProvider: row.metadata.storage_provider || 'supabase'
          })
        });
        const body = await res.json().catch(() => ({}));
        return { id: row.id, status: body.status || `HTTP ${res.status}` };
      })
  );

  const driven = results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'sweep-error' }));
  console.log('[Cron Drive]', JSON.stringify(driven));
  return NextResponse.json({ ok: true, driven: driven.length, results: driven });
}

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { serviceClient, newId, saveFilm, loadFilm } from '@/lib/film/store';
import { putFile, resolveUrl, signDeep } from '@/lib/vfx/store';
import { pickShots, measureItems, buildEdl, buildFcpXml, buildQaReport } from '@/lib/film/export';
import { assertTier } from '@/lib/credits/packages';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST { user_email, film_id, scope: 'film'|'act'|'scene', scope_id?, include_unapproved?, render? }
 * Writes EDL + FCP XML + manifest + QA report (JSON/CSV) for the chosen span, optionally a
 * flattened MP4 through the dialogue merge (same 300 s discipline as the VFX export).
 * Files live in private storage; the response carries signed URLs.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    const supabase = serviceClient();
    await assertTier(email, 'ultra', supabase);
    const film = await loadFilm(email, body.film_id || '', supabase);
    if (!film) return NextResponse.json({ success: false, error: 'ไม่พบหนัง' }, { status: 404 });
    const scope: 'film' | 'act' | 'scene' = ['film', 'act', 'scene'].includes(body.scope) ? body.scope : 'film';
    const scopeId = scope === 'film' ? undefined : String(body.scope_id || '');
    const scopeName = scope === 'film' ? film.title : scope === 'act' ? (film.acts.find((a) => a.id === scopeId)?.name || 'องก์') : (film.scenes.find((s) => s.id === scopeId)?.name || 'ฉาก');
    if (scope !== 'film' && !scopeId) return NextResponse.json({ success: false, error: 'ต้องระบุองก์/ฉาก' }, { status: 400 });

    const picked = pickShots(film, scope, scopeId, body.include_unapproved === true);
    if (!picked.length) return NextResponse.json({ success: false, error: body.include_unapproved ? 'ไม่มีช็อตที่เสร็จแล้วในช่วงนี้' : 'ไม่มีช็อตที่อนุมัติแล้วในช่วงนี้ — อนุมัติก่อน หรือเลือก "รวมช็อตที่ยังไม่อนุมัติ"' }, { status: 409 });
    const items = await measureItems(film, picked, (ref) => resolveUrl(ref, supabase));
    const fps = film.bible.fps;
    const title = scope === 'film' ? film.title : `${film.title} — ${scopeName}`;
    const edl = buildEdl(title, items, fps);
    const xml = buildFcpXml(title, items, fps);
    const qa = buildQaReport(film, items);
    const manifest = {
      film: film.title, film_id: film.id, scope, scope_name: scopeName, fps, generated_at: new Date().toISOString(), bible_version: film.bible.version, pinned_models: film.pinned_models,
      clips: items.map((it) => ({ file: it.name, url: it.url, scene: it.scene.order, scene_name: it.scene.name, shot: it.shot.order, status: it.shot.status, seconds: +it.seconds.toFixed(2), width: it.width, height: it.height, grade: it.shot.post_grade_url ? 'post' : 'pre', delta_e: it.shot.delta_e ?? null })),
      note: 'signed URLs expire in 1 hour — re-export for fresh links; file names are stable so relinking in the NLE is a folder swap'
    };

    const id = newId('exp');
    const base = `films/${email}/${film.id}/exports/${id}`;
    const files = {
      edl: await putFile(`${base}/${film.id}_${scope}.edl`, Buffer.from(edl, 'utf8'), 'text/plain', supabase),
      xml: await putFile(`${base}/${film.id}_${scope}.xml`, Buffer.from(xml, 'utf8'), 'application/xml', supabase),
      manifest: await putFile(`${base}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'application/json', supabase),
      qa_json: await putFile(`${base}/qa_report.json`, Buffer.from(JSON.stringify(qa.json, null, 2), 'utf8'), 'application/json', supabase),
      qa_csv: await putFile(`${base}/qa_report.csv`, Buffer.from('﻿' + qa.csv, 'utf8'), 'text/csv', supabase)
    } as Record<string, string>;

    if (body.render === true) {
      // one clip is the cut itself; several go through the dialogue merge (normalized concat)
      if (items.length === 1) files.mp4 = items[0].shot.post_grade_url || items[0].shot.pre_grade_url!;
      else {
        const r = items[0].width / Math.max(1, items[0].height);
        const res = await fetch(`${req.nextUrl.origin}/api/merge-dialogue`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: req.headers.get('authorization') || '' },
          body: JSON.stringify({ title: `${title} (Film export)`, videoClips: items.map((it) => ({ videoUrl: it.url, cropX: null, cropY: null, cropW: null, cropH: null })), user_email: email, user_id: film.user_id, aspectRatio: r > 1.2 ? '16:9' : r < 0.85 ? '9:16' : '1:1', baseImageUrl: null, faceTags: null, normalize: true, trimSilence: false, colorMatch: false })
        });
        const j = await res.json();
        if (!j.success) throw new Error(j.error || 'รวมช็อตไม่สำเร็จ');
        files.mp4 = j.videoUrl;
      }
    }

    const record = { id, scope, scope_id: scopeId, scope_name: scopeName, shots: items.length, seconds: +items.reduce((s, it) => s + it.seconds, 0).toFixed(2), fps, files: files as any, at: new Date().toISOString() };
    film.exports.unshift(record);
    film.exports = film.exports.slice(0, 20);
    await saveFilm(film, supabase);
    return NextResponse.json({ success: true, export: await signDeep(record, supabase), qa_summary: qa.json.summary, film: await signDeep(film, supabase) });
  } catch (e: any) {
    console.error('[Film export]', e);
    return NextResponse.json({ success: false, error: e?.message || 'ส่งออกไม่สำเร็จ' }, { status: 500 });
  }
}

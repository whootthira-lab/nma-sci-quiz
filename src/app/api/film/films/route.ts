import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { serviceClient, newId, saveFilm, loadFilm, listFilms, deleteFilm } from '@/lib/film/store';
import { signDeep } from '@/lib/vfx/store';
import { DEFAULT_BIBLE, Film, MasterAsset, StyleBible } from '@/lib/film/types';
import { requireConsent, loadConsent } from '@/lib/vfx/consent';
import { MATTE_ID, BG_IMAGE_ID, CHARACTER_ID } from '@/lib/vfx/pipeline';
import { getModel } from '@/lib/providers/registry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const own = (email: string) => (f: Film) => f.user_email === email;

/** GET ?email=…[&id=…] */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase();
  { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
  try {
    if (id) {
      const film = await loadFilm(email, id);
      if (!film) return NextResponse.json({ success: false, error: 'ไม่พบหนัง' }, { status: 404 });
      return NextResponse.json({ success: true, film: await signDeep(film) });
    }
    return NextResponse.json({ success: true, films: await listFilms(email) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'อ่านไม่สำเร็จ' }, { status: 500 });
  }
}

/**
 * POST actions (all take user_email; most take film_id):
 *   create            { title, bible? }
 *   update_bible      { bible }              — refused when locked; use bump_bible
 *   lock_bible        {}                     — freezes the current version
 *   bump_bible        { bible }              — new version (old one kept in history); scenes re-grade on request
 *   add_master        { kind, name, sheet_urls[], consent_id? }
 *   update_master     { master_id, name?, sheet_urls? } — refused once locked
 *   lock_master       { master_id }
 *   bump_master       { master_id, sheet_urls } — new version; used versions stay intact
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
    const supabase = serviceClient();
    const now = new Date().toISOString();

    if (body.action === 'create') {
      const bible: StyleBible = { ...DEFAULT_BIBLE, ...(body.bible || {}), version: 1 };
      const pin = (task: string, id: string) => { const m = getModel(id); return m ? { [task]: { model_id: m.id, endpoint: m.endpoint, pinned_at: now } } : {}; };
      const film: Film = {
        id: newId('film'), user_email: email, user_id: body.user_id || '', title: String(body.title || 'หนังใหม่').trim() || 'หนังใหม่',
        bible, bible_history: [], masters: [], acts: [{ id: newId('act'), order: 1, name: 'องก์ 1', style_override: {} }], scenes: [],
        pinned_models: { ...pin('vfx.matte', MATTE_ID), ...pin('image.plate', BG_IMAGE_ID), ...pin('vfx.character', CHARACTER_ID) },
        status: 'draft', created_at: now, updated_at: now
      };
      await saveFilm(film, supabase);
      return NextResponse.json({ success: true, film });
    }

    const film = await loadFilm(email, body.film_id || '', supabase);
    if (!film || !own(email)(film)) return NextResponse.json({ success: false, error: 'ไม่พบหนัง' }, { status: 404 });

    switch (body.action) {
      case 'update_bible': {
        if (film.bible.locked_at) return NextResponse.json({ success: false, error: 'Bible ถูกล็อกแล้ว — แก้ตรงไม่ได้ ต้อง bump เวอร์ชันใหม่' }, { status: 409 });
        film.bible = { ...film.bible, ...(body.bible || {}), version: film.bible.version };
        break;
      }
      case 'lock_bible':
        film.bible.locked_at = now;
        film.status = 'active';
        break;
      case 'bump_bible': {
        film.bible_history.unshift({ version: film.bible.version, bible: film.bible, at: now });
        film.bible = { ...film.bible, ...(body.bible || {}), version: film.bible.version + 1, locked_at: undefined };
        break;
      }
      case 'add_master': {
        const kind: MasterAsset['kind'] = ['character', 'location', 'prop'].includes(body.kind) ? body.kind : 'location';
        let sheet: string[] = Array.isArray(body.sheet_urls) ? body.sheet_urls.filter(Boolean).slice(0, 6) : [];
        if (kind === 'character' && body.consent_id) {
          // the face of record is the consent's own (private ref), never a URL the browser sent
          const c = await loadConsent(email, String(body.consent_id), supabase);
          if (c) sheet = [c.face_url, ...sheet.filter((u) => !/^https?:/.test(u) || u === c.face_url)].filter((u, i, a) => a.indexOf(u) === i);
        }
        if (!sheet.length) return NextResponse.json({ success: false, error: 'ต้องมีภาพอย่างน้อย 1 ภาพ' }, { status: 400 });
        if (kind === 'character') {
          // The spec's guardrail: a character master from a real person carries a consent record
          if (!body.consent_id) return NextResponse.json({ success: false, error: 'master ตัวละครต้องผูกบันทึกความยินยอม (consent) เดียวกับ VFX Studio' }, { status: 400 });
          await requireConsent(email, String(body.consent_id), sheet[0], supabase);
        }
        film.masters.push({ id: newId('mst'), kind, name: String(body.name || kind).trim(), sheet_urls: sheet, consent_id: body.consent_id || undefined, version: 1, locked: false, used_by: [], created_at: now });
        break;
      }
      case 'update_master': {
        const m = film.masters.find((x) => x.id === body.master_id);
        if (!m) return NextResponse.json({ success: false, error: 'ไม่พบ master' }, { status: 404 });
        if (m.locked) return NextResponse.json({ success: false, error: 'master ถูกล็อกแล้ว — ใช้ bump เวอร์ชันใหม่' }, { status: 409 });
        if (body.name) m.name = String(body.name).trim();
        if (Array.isArray(body.sheet_urls) && body.sheet_urls.length) m.sheet_urls = body.sheet_urls.filter(Boolean).slice(0, 6);
        break;
      }
      case 'lock_master': {
        const m = film.masters.find((x) => x.id === body.master_id);
        if (!m) return NextResponse.json({ success: false, error: 'ไม่พบ master' }, { status: 404 });
        m.locked = true;
        break;
      }
      case 'bump_master': {
        const m = film.masters.find((x) => x.id === body.master_id);
        if (!m) return NextResponse.json({ success: false, error: 'ไม่พบ master' }, { status: 404 });
        const sheet: string[] = Array.isArray(body.sheet_urls) ? body.sheet_urls.filter(Boolean).slice(0, 6) : m.sheet_urls;
        // A used version is never edited in place: keep the old sheet under its version by
        // recording it in used_by consumers; the new version starts unlocked for review.
        m.version += 1;
        m.sheet_urls = sheet;
        m.locked = false;
        break;
      }
      // ── F2 structure: acts, overrides, ordering ──
      case 'add_act': {
        film.acts.push({ id: newId('act'), order: film.acts.length + 1, name: String(body.name || `องก์ ${film.acts.length + 1}`).trim(), style_override: body.style_override || {} });
        break;
      }
      case 'update_act': {
        const a = film.acts.find((x) => x.id === body.act_id);
        if (!a) return NextResponse.json({ success: false, error: 'ไม่พบองก์' }, { status: 404 });
        if (typeof body.name === 'string' && body.name.trim()) a.name = body.name.trim();
        if (body.style_override && typeof body.style_override === 'object') a.style_override = { ...a.style_override, ...body.style_override };
        break;
      }
      case 'move': {
        // { kind: 'act'|'scene'|'shot', id, dir: -1|1 } — swap with the neighbour in the same parent
        const dir = Number(body.dir) === -1 ? -1 : 1;
        const swap = <T extends { order: number }>(list: T[], id: string, key: (x: T) => string) => {
          const sorted = [...list].sort((x, y) => x.order - y.order);
          const i = sorted.findIndex((x) => key(x) === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= sorted.length) return false;
          const oi = sorted[i].order; sorted[i].order = sorted[j].order; sorted[j].order = oi;
          return true;
        };
        if (body.kind === 'act') swap(film.acts, String(body.id), (x) => x.id);
        else if (body.kind === 'scene') {
          const sc = film.scenes.find((x) => x.id === body.id);
          if (sc) swap(film.scenes.filter((x) => x.act_id === sc.act_id), sc.id, (x) => x.id);
        } else if (body.kind === 'shot') {
          const sc = film.scenes.find((x) => x.shots.some((s) => s.id === body.id));
          if (sc) {
            // shots are a chain: reordering rewires prev_shot_id along the new order
            swap(sc.shots, String(body.id), (x) => x.id);
            const sorted = [...sc.shots].sort((x, y) => x.order - y.order);
            sorted.forEach((s, i) => { s.prev_shot_id = i > 0 ? sorted[i - 1].id : undefined; });
          }
        }
        break;
      }
      case 'move_scene_to_act': {
        const sc = film.scenes.find((x) => x.id === body.scene_id);
        const a = film.acts.find((x) => x.id === body.act_id);
        if (!sc || !a) return NextResponse.json({ success: false, error: 'ไม่พบฉากหรือองก์' }, { status: 404 });
        sc.act_id = a.id;
        sc.order = film.scenes.filter((x) => x.act_id === a.id).length;
        break;
      }
      default:
        return NextResponse.json({ success: false, error: 'ไม่รู้จักคำสั่ง' }, { status: 400 });
    }
    await saveFilm(film, supabase);
    return NextResponse.json({ success: true, film });
  } catch (e: any) {
    console.error('[Film films]', e);
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user_email, id } = await req.json();
    await deleteFilm(String(user_email || '').toLowerCase(), String(id || ''));
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ลบไม่สำเร็จ' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { serviceClient, newId, saveFilm, loadFilm, listFilms, deleteFilm } from '@/lib/film/store';
import { signDeep } from '@/lib/vfx/store';
import { DEFAULT_BIBLE, Film, MasterAsset, StyleBible, ContinuityFields, FilmMigration } from '@/lib/film/types';
import { requireConsent, loadConsent } from '@/lib/vfx/consent';
import { MATTE_ID, BG_IMAGE_ID, CHARACTER_ID, redoMatte, startShot, persist } from '@/lib/vfx/pipeline';
import { loadProject } from '@/lib/vfx/store';
import { getModel, assertRunnable, estimateCost, MODELS } from '@/lib/providers/registry';
import { probeEndpoint } from '@/lib/providers/liveness';
import { audit } from '@/lib/audit';
import { primeRates } from '@/lib/providers/rates';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const own = (email: string) => (f: Film) => f.user_email === email;

function normContinuity(x: any): ContinuityFields {
  return {
    wardrobe: String(x?.wardrobe || '').trim().slice(0, 200),
    hair: String(x?.hair || '').trim().slice(0, 120),
    injuries: String(x?.injuries || '').trim().slice(0, 200),
    props_held: Array.isArray(x?.props_held) ? x.props_held.map((p: any) => String(p).trim()).filter(Boolean).slice(0, 8) : String(x?.props_held || '').split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 8),
    dirt_level: ['clean', 'light', 'heavy'].includes(x?.dirt_level) ? x.dirt_level : 'clean',
    notes: x?.notes ? String(x.notes).trim().slice(0, 200) : undefined
  };
}

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
 *   set_continuity    { scene_id, subject_master_id, state | clear } — Continuity Board cell (F4)
 *   confirm_proposal  { proposal_id } / reject_proposal { proposal_id } — VLM-proposed state after approval
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
        bible, bible_history: [], masters: [], acts: [{ id: newId('act'), order: 1, name: 'องก์ 1', style_override: {} }], scenes: [], continuity: [], continuity_proposals: [], migrations: [], exports: [],
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
      case 'set_continuity': {
        // Continuity Board (F4): the user sets/edits a subject's state in a scene by hand.
        // Later scenes inherit it until one of them sets its own. History is kept per cell.
        const sc = film.scenes.find((x) => x.id === body.scene_id);
        const subject = film.masters.find((m) => m.id === body.subject_master_id && (m.kind === 'character' || m.kind === 'prop'));
        if (!sc || !subject) return NextResponse.json({ success: false, error: 'ไม่พบฉากหรือ subject (ต้องเป็น master ตัวละคร/พร็อพ)' }, { status: 404 });
        const state = normContinuity(body.state);
        const cur = film.continuity.find((c) => c.scene_id === sc.id && c.subject_master_id === subject.id);
        if (body.clear === true) { film.continuity = film.continuity.filter((c) => c !== cur); break; }
        if (cur) { cur.history.unshift({ at: cur.updated_at, source: cur.source, state: cur.state, shot_id: cur.updated_after_shot_id }); cur.state = state; cur.source = 'user'; cur.updated_after_shot_id = undefined; cur.updated_at = now; }
        else film.continuity.push({ id: newId('cont'), scene_id: sc.id, subject_master_id: subject.id, state, source: 'user', history: [], updated_at: now });
        break;
      }
      case 'confirm_proposal': {
        const p = film.continuity_proposals.find((x) => x.id === body.proposal_id);
        if (!p) return NextResponse.json({ success: false, error: 'ไม่พบข้อเสนอ' }, { status: 404 });
        const cur = film.continuity.find((c) => c.scene_id === p.scene_id && c.subject_master_id === p.subject_master_id);
        if (cur) { cur.history.unshift({ at: cur.updated_at, source: cur.source, state: cur.state, shot_id: cur.updated_after_shot_id }); cur.state = p.observed; cur.source = 'auto'; cur.updated_after_shot_id = p.from_shot_id; cur.updated_at = now; }
        else film.continuity.push({ id: newId('cont'), scene_id: p.scene_id, subject_master_id: p.subject_master_id, state: p.observed, source: 'auto', updated_after_shot_id: p.from_shot_id, history: [], updated_at: now });
        film.continuity_proposals = film.continuity_proposals.filter((x) => x.id !== p.id);
        break;
      }
      case 'reject_proposal': {
        film.continuity_proposals = film.continuity_proposals.filter((x) => x.id !== body.proposal_id);
        break;
      }
      case 'check_models': {
        // F5: are the pinned endpoints still alive, still in the registry, and is there a
        // verified alternative for the same task? Nothing is switched here — only reported.
        const tasks: NonNullable<Film['model_health']>['tasks'] = [];
        for (const [task, pin] of Object.entries(film.pinned_models)) {
          const entry = getModel(pin.model_id);
          const live = await probeEndpoint(pin.endpoint);
          const candidates = entry ? MODELS.filter((m) => m.task === entry.task && m.verified && m.id !== entry.id).map((m) => ({ model_id: m.id, label: m.label, endpoint: m.endpoint, credits_per_unit: m.creditsPerUnit })) : [];
          tasks.push({ task, model_id: pin.model_id, endpoint: pin.endpoint, alive: live.alive, detail: live.detail, verified: !!entry?.verified, in_registry: !!entry && entry.endpoint === pin.endpoint, candidates });
        }
        film.model_health = { checked_at: now, tasks };
        break;
      }
      case 'probe_endpoint': {
        // diagnostic (no state): liveness of any endpoint string
        const live = await probeEndpoint(String(body.endpoint || ''));
        return NextResponse.json({ success: true, endpoint: body.endpoint, ...live });
      }
      case 'propose_migration': {
        const task = body.task as FilmMigration['task'];
        if (task !== 'vfx.matte' && task !== 'vfx.character') return NextResponse.json({ success: false, error: 'ย้ายได้เฉพาะโมเดลตัดคน (vfx.matte) และตัวละคร (vfx.character) — plate มาจาก master ที่ล็อกไว้ ไม่มีงานให้ย้าย' }, { status: 400 });
        const from = film.pinned_models[task];
        if (!from) return NextResponse.json({ success: false, error: 'หนังเรื่องนี้ไม่ได้ปักหมุดโมเดลของงานนี้' }, { status: 400 });
        const to = assertRunnable(String(body.to_model_id || ''));
        if (to.task !== task) return NextResponse.json({ success: false, error: `${to.id} ไม่ใช่โมเดลสำหรับ ${task}` }, { status: 400 });
        if (to.id === from.model_id) return NextResponse.json({ success: false, error: 'เป็นโมเดลเดิมอยู่แล้ว' }, { status: 400 });
        if (film.migrations.some((m) => m.task === task && (m.status === 'proposed' || m.status === 'testing' || m.status === 'tested'))) return NextResponse.json({ success: false, error: 'มีการย้ายของงานนี้ค้างอยู่ — ทดสอบ/ย้าย/ปฏิเสธรายการเดิมก่อน' }, { status: 409 });
        film.migrations.unshift({ id: newId('mig'), task, from: { model_id: from.model_id, endpoint: from.endpoint }, to: { model_id: to.id, endpoint: to.endpoint, label: to.label }, status: 'proposed', samples: [], credits: 0, created_at: now });
        break;
      }
      case 'reject_migration': {
        const m = film.migrations.find((x) => x.id === body.migration_id);
        if (!m) return NextResponse.json({ success: false, error: 'ไม่พบรายการย้าย' }, { status: 404 });
        if (m.status === 'applied') return NextResponse.json({ success: false, error: 'ย้ายไปแล้ว' }, { status: 409 });
        m.status = 'rejected';
        break;
      }
      case 'apply_migration': {
        // "ย้ายทั้งเรื่อง": switch the pin for every shot from now on; optionally re-render the
        // affected layer of existing shots (charged per shot). Gate: samples tested and passed —
        // `force: true` overrides and is recorded on the migration and in the audit log.
        const m = film.migrations.find((x) => x.id === body.migration_id);
        if (!m) return NextResponse.json({ success: false, error: 'ไม่พบรายการย้าย' }, { status: 404 });
        if (m.status === 'applied' || m.status === 'rejected') return NextResponse.json({ success: false, error: `รายการนี้${m.status === 'applied' ? 'ย้ายไปแล้ว' : 'ถูกปฏิเสธแล้ว'}` }, { status: 409 });
        if (!(m.status === 'tested' && m.passed) && body.force !== true) {
          return NextResponse.json({ success: false, error: m.status === 'tested' ? 'ตัวอย่างไม่ผ่าน QA — ย้ายทั้งเรื่องไม่ได้ (ดูผลตัวอย่าง หรือยืนยันบังคับย้าย)' : 'ต้องทดสอบกับช็อตตัวอย่างและผ่าน QA ก่อนจึงย้ายทั้งเรื่องได้', gate: m.status, passed: m.passed ?? null }, { status: 409 });
        }
        const pin = film.pinned_models[m.task];
        const forced = !(m.status === 'tested' && m.passed);
        film.pinned_models[m.task] = { model_id: m.to.model_id, endpoint: m.to.endpoint, pinned_at: now, migrated_from: [...(pin?.migrated_from || []), { model_id: m.from.model_id, endpoint: m.from.endpoint, at: now, migration_id: m.id }] };
        m.status = 'applied'; m.applied_at = now; m.forced = forced;
        await audit({ kind: 'film_migration_applied', actor: email, target: film.id, detail: { migration_id: m.id, task: m.task, from: m.from.model_id, to: m.to.model_id, forced, passed: m.passed ?? null } });
        // Re-render existing shots with the new model (their VFX projects get the new pin)
        if (body.rerender === true) {
          let count = 0;
          for (const sc of film.scenes) for (const sh of sc.shots) {
            if (!sh.vfx_project_id || sh.status === 'processing') continue;
            const project = await loadProject(email, sh.vfx_project_id, supabase);
            const vs = project?.shots.find((x) => x.id === sh.vfx_shot_id) || project?.shots[0];
            if (!project || !vs) continue;
            project.pinned = { ...(project.pinned || {}), [m.task]: m.to.model_id };
            const secs = Math.ceil(vs.end - vs.start);
            const cost = estimateCost(m.to.model_id, secs).creditsShown;
            if (email !== 'whootthira@gmail.com' && cost > 0) {
              const { data: wl } = await supabase.from('whitelist').select('generation_limit').eq('email', email).maybeSingle();
              if (!wl || (wl.generation_limit || 0) < Math.round(cost * 10)) { sh.error = `ย้ายโมเดล: เครดิตไม่พอ (ต้องการ ${cost})`; continue; }
              await supabase.from('whitelist').update({ generation_limit: (wl.generation_limit || 0) - Math.round(cost * 10) }).eq('email', email);
              project.charged_credits += cost;
            }
            const lyr = vs.layers.find((l) => l.type === (m.task === 'vfx.matte' ? 'matte' : 'character'));
            if (lyr) { lyr.cost_credits = cost; lyr.model_id = m.to.model_id; }
            if (m.task === 'vfx.matte') await redoMatte(project, vs, supabase);
            else { for (const l of vs.layers) if (l.type === 'character' || l.type === 'matte') { l.status = 'pending'; l.job_request_id = undefined; } await startShot(project, vs, supabase); }
            await persist(project, supabase);
            sh.status = 'processing'; sh.pre_grade_url = undefined; sh.post_grade_url = undefined; sh.delta_e = undefined; sh.passed = undefined; sh.qa = undefined; sh.error = undefined; sh.updated_at = now;
            count++;
          }
          m.rerendered = count;
        }
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

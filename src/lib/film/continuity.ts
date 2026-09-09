import type { Film, FilmScene, FilmShot, MasterAsset, ContinuityFields, ContinuityState, ContinuityCheck } from './types';
import { EMPTY_CONTINUITY } from './types';
import { extractFrame } from './color';
import { geminiUrl, geminiText } from '@/lib/gemini';
import { resolveUrl } from '@/lib/vfx/store';

/**
 * Continuity (Film F4).
 *
 * The continuity DB is `film.continuity`: one ContinuityState per (scene, subject master).
 * A scene without its own state for a subject inherits the latest state of an EARLIER scene
 * (film order: act → scene), so wardrobe set in scene 1 carries through until a later scene
 * changes it. The resolver attaches the effective states to every shot's effective_style and
 * turns them into a continuity clause for generative layers; the VLM check compares finished
 * shots against the same states and flags contradictions (wardrobe / hair / injuries /
 * props / dirt). After a shot is approved the VLM's observed state becomes a PROPOSAL the
 * user confirms before it is saved — the board is never rewritten silently.
 */

export interface EffectiveContinuity {
  subject_master_id: string;
  name: string;
  kind: MasterAsset['kind'];
  state: ContinuityFields;
  source: 'user' | 'auto' | 'none';
  /** the scene the state was inherited from, when not set on this scene */
  inherited_from_scene_id?: string;
}

/** scenes in film order (act order, then scene order) */
export function orderedScenes(film: Film): FilmScene[] {
  const actOrder = new Map((film.acts || []).map((a) => [a.id, a.order] as const));
  return [...film.scenes].sort((a, b) => (actOrder.get(a.act_id || '') ?? 0) - (actOrder.get(b.act_id || '') ?? 0) || a.order - b.order);
}

/** subjects of a scene: explicit list, else every character/prop master of the film */
export function sceneSubjects(film: Film, scene: FilmScene): MasterAsset[] {
  const all = film.masters.filter((m) => m.kind === 'character' || m.kind === 'prop');
  if (Array.isArray(scene.subject_master_ids)) return all.filter((m) => scene.subject_master_ids!.includes(m.id));
  return all;
}

export function isEmptyState(s: ContinuityFields | undefined): boolean {
  if (!s) return true;
  return !s.wardrobe && !s.hair && !s.injuries && !(s.props_held || []).length && (!s.dirt_level || s.dirt_level === 'clean') && !s.notes;
}

export function effectiveContinuity(film: Film, scene: FilmScene): EffectiveContinuity[] {
  const scenes = orderedScenes(film);
  const idx = scenes.findIndex((s) => s.id === scene.id);
  const out: EffectiveContinuity[] = [];
  for (const m of sceneSubjects(film, scene)) {
    let found: ContinuityState | undefined;
    let inheritedFrom: string | undefined;
    for (let i = idx; i >= 0; i--) {
      const st = (film.continuity || []).find((c) => c.scene_id === scenes[i].id && c.subject_master_id === m.id);
      if (st) { found = st; if (i !== idx) inheritedFrom = scenes[i].id; break; }
    }
    out.push({ subject_master_id: m.id, name: m.name, kind: m.kind, state: found ? { ...EMPTY_CONTINUITY, ...found.state } : { ...EMPTY_CONTINUITY }, source: found ? found.source : 'none', inherited_from_scene_id: inheritedFrom });
  }
  return out;
}

/** the clause generative layers receive — plain descriptors, no colour-grade words */
export function continuityPrompt(states: EffectiveContinuity[]): string {
  const parts: string[] = [];
  for (const s of states) {
    if (isEmptyState(s.state)) continue;
    const d: string[] = [];
    if (s.state.wardrobe) d.push(`wearing ${s.state.wardrobe}`);
    if (s.state.hair) d.push(`hair ${s.state.hair}`);
    if (s.state.injuries) d.push(`injuries: ${s.state.injuries}`);
    if (s.state.props_held?.length) d.push(`holding ${s.state.props_held.join(', ')}`);
    if (s.state.dirt_level && s.state.dirt_level !== 'clean') d.push(`${s.state.dirt_level === 'heavy' ? 'heavily' : 'lightly'} dirtied`);
    if (s.state.notes) d.push(s.state.notes);
    parts.push(`${s.name} (${s.kind}): ${d.join(', ')}`);
  }
  return parts.join('; ');
}

/** the VLM writes "none" / "n/a" for absent things — that is an empty field on the board */
const clean = (v: any) => { const s = String(v || '').trim(); return /^(none|n\/a|na|-|null|no .*|nothing)$/i.test(s) ? '' : s; };

function normFields(x: any): ContinuityFields {
  const dirt = ['clean', 'light', 'heavy'].includes(x?.dirt_level) ? x.dirt_level : 'clean';
  return {
    wardrobe: clean(x?.wardrobe),
    hair: clean(x?.hair),
    injuries: clean(x?.injuries),
    props_held: Array.isArray(x?.props_held) ? x.props_held.map((p: any) => clean(p)).filter(Boolean).slice(0, 8) : [],
    dirt_level: dirt,
    notes: x?.notes ? String(x.notes).trim().slice(0, 200) : undefined
  };
}

/** textual diff for the proposal card */
export function diffState(expected: ContinuityFields, observed: ContinuityFields): string[] {
  const out: string[] = [];
  const cmp = (k: keyof ContinuityFields, label: string) => {
    const a = String((expected as any)[k] || '').trim(); const b = String((observed as any)[k] || '').trim();
    if (a.toLowerCase() !== b.toLowerCase()) out.push(`${label}: "${a || '—'}" → "${b || '—'}"`);
  };
  cmp('wardrobe', 'เสื้อผ้า'); cmp('hair', 'ทรงผม'); cmp('injuries', 'บาดแผล'); cmp('dirt_level', 'ความสกปรก');
  const pa = (expected.props_held || []).join(', '); const pb = (observed.props_held || []).join(', ');
  if (pa.toLowerCase() !== pb.toLowerCase()) out.push(`พร็อพที่ถือ: "${pa || '—'}" → "${pb || '—'}"`);
  return out;
}

async function imageBase64(url: string): Promise<string | null> {
  try { const r = await fetch(await resolveUrl(url)); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()).toString('base64'); } catch { return null; }
}

/**
 * One VLM call per shot: a mid frame and the last frame of the shot, the subject sheets, and
 * the expected states. Returns, per subject, whether it is in frame, whether it contradicts
 * the expected state (with Thai issues) and the state observed at the END of the shot (the
 * state the next shot inherits). Null when the model is unavailable — never blocks.
 */
export async function inspectContinuity(videoUrl: string, subjects: EffectiveContinuity[], masters: MasterAsset[]): Promise<ContinuityCheck | null> {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key || !subjects.length) return null;
  try {
    const [mid, last] = await Promise.all([extractFrame(videoUrl, 1.0).catch(() => null), extractFrame(videoUrl, -0.3).catch(() => null)]);
    if (!mid && !last) return null;
    const parts: any[] = [];
    let text = `You are a script supervisor checking continuity. Images 1${last && mid ? ' and 2' : ''} are frames from a new shot (${mid && last ? 'middle, then the last frame' : 'one frame'}).`;
    const sheetIdx: string[] = [];
    if (mid) parts.push({ inline_data: { mime_type: 'image/jpeg', data: mid.toString('base64') } });
    if (last) parts.push({ inline_data: { mime_type: 'image/jpeg', data: last.toString('base64') } });
    let n = parts.length;
    for (const s of subjects) {
      const m = masters.find((x) => x.id === s.subject_master_id);
      const sheet = m?.sheet_urls[0] ? await imageBase64(m.sheet_urls[0]) : null;
      if (sheet) { n++; parts.push({ inline_data: { mime_type: 'image/jpeg', data: sheet } }); sheetIdx.push(`image ${n} = reference sheet of subject "${s.name}" (id ${s.subject_master_id})`); }
    }
    text += sheetIdx.length ? ` ${sheetIdx.join('; ')}.` : '';
    text += `\nSubjects and the continuity state they MUST match in this scene (empty fields = not yet defined, just observe):\n${JSON.stringify(subjects.map((s) => ({ id: s.subject_master_id, name: s.name, kind: s.kind, expected: s.state })))}\n` +
      `For each subject decide: present (is it visible in the frames), consistent (no contradiction with the non-empty expected fields — ignore pose, framing and lighting; only wardrobe, hair, injuries/marks, held props and dirt/wetness count), issues (Thai, one short sentence each, empty if consistent), observed (the state seen in the LAST frame: wardrobe, hair, injuries, props_held[], dirt_level clean|light|heavy — short English descriptors). Reply with JSON only: {"subjects":[{"id":"...","present":true,"consistent":true,"issues":[],"observed":{"wardrobe":"","hair":"","injuries":"","props_held":[],"dirt_level":"clean"}}]}`;
    parts.unshift({ text });
    const res = await fetch(`${geminiUrl()}?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } }) });
    if (!res.ok) { console.warn('[Film continuity] gemini', res.status); return null; }
    const m = geminiText(await res.json()).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const rows: any[] = Array.isArray(j.subjects) ? j.subjects : [];
    const per = subjects.map((s) => {
      const r = rows.find((x) => x.id === s.subject_master_id) || rows.find((x) => String(x.name || '').toLowerCase() === s.name.toLowerCase());
      if (!r) return { subject_master_id: s.subject_master_id, present: false, consistent: true, issues: [] as string[] };
      const present = r.present !== false;
      const consistent = !present || r.consistent !== false;
      return { subject_master_id: s.subject_master_id, present, consistent, issues: present ? (Array.isArray(r.issues) ? r.issues.map(String).slice(0, 5) : []) : [], observed: present && r.observed ? normFields(r.observed) : undefined };
    });
    return { passed: per.every((p) => p.consistent), per_subject: per, checked_at: new Date().toISOString() };
  } catch (e) {
    console.warn('[Film continuity] skipped:', (e as any)?.message || e);
    return null;
  }
}

/** shots of a scene that can be inspected (post-matte output exists) */
export function inspectableShots(scene: FilmScene): FilmShot[] {
  return scene.shots.filter((s) => !!(s.post_grade_url || s.pre_grade_url) && s.status !== 'processing' && s.status !== 'failed');
}

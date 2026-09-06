import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from './store';
import type { VfxEngine, VfxGrade } from './types';
import type { FxParams } from './fx';

/**
 * Scene templates (Phase 4): a saved look — brief, grade, effects, engine, and optionally
 * a fixed background plate. Picking one fills the studio in one click; a template with a
 * plate reuses that image for every shot, so a series keeps one location and skips the
 * Flux call. Anyone can save a finished project's look; the built-in set ships below.
 *
 * kruth-ai-assets/vfx_templates/library.json (shared) — per-user ones carry `owner`.
 */
export interface SceneTemplate {
  id: string;
  label: string;
  thumbnail_url?: string;
  instruction: string;          // the brief the planner writes prompts from
  engine: VfxEngine;
  grade: VfxGrade;
  fx: FxParams[];
  background_image_url?: string; // fixed plate (skips generation)
  owner?: string;                // email; absent = built-in
  created_at: string;
}

const BUCKET = 'kruth-ai-assets';
const PATH = 'vfx_templates/library.json';

export const BUILTIN_TEMPLATES: SceneTemplate[] = [
  { id: 'lab', label: '🧪 ห้องแล็บวิทยาศาสตร์', instruction: 'a bright modern science laboratory with white benches, glassware and soft daylight from large windows', engine: 'matte', grade: 'match', fx: [], created_at: '2026-09-06' },
  { id: 'library', label: '📚 ห้องสมุด', instruction: 'a warm modern library with tall wooden bookshelves, reading tables and window light', engine: 'matte', grade: 'match', fx: [], created_at: '2026-09-06' },
  { id: 'newsroom', label: '📺 สตูดิโอข่าว', instruction: 'a sleek television news studio with a large LED wall, blue and white accent lighting, glossy desk', engine: 'matte', grade: 'cool', fx: [], created_at: '2026-09-06' },
  { id: 'cafe', label: '☕ คาเฟ่', instruction: 'a cozy coffee shop interior with wooden tables, plants, pendant lamps and afternoon sunlight', engine: 'matte', grade: 'warm', fx: [{ fx_id: 'dust', opacity: 0.35, placement: 'front', blend: 'screen' }], created_at: '2026-09-06' },
  { id: 'jazzbar', label: '🎷 บาร์แจ๊สยามค่ำ', instruction: 'a dim cozy jazz bar at night with warm pendant lamps, a brick wall and leather booths', engine: 'matte', grade: 'match', fx: [{ fx_id: 'smoke', opacity: 0.5, placement: 'behind', blend: 'screen' }], created_at: '2026-09-06' },
  { id: 'office', label: '🏢 สำนักงานทันสมัย', instruction: 'a modern open-plan office with glass partitions, city view through floor-to-ceiling windows, neutral daylight', engine: 'matte', grade: 'match', fx: [], created_at: '2026-09-06' },
  { id: 'street-night', label: '🌃 ถนนเมืองกลางคืน', instruction: 'a rainy city street at night with neon signs, wet asphalt reflections and bokeh headlights', engine: 'o3', grade: 'cinematic', fx: [{ fx_id: 'rain', opacity: 0.5, placement: 'front', blend: 'screen' }], created_at: '2026-09-06' },
  { id: 'forest', label: '🌿 ป่าและแสงธรรมชาติ', instruction: 'a lush tropical forest path with sun rays through the canopy, soft mist, green and gold tones', engine: 'matte', grade: 'match', fx: [{ fx_id: 'dust', opacity: 0.45, placement: 'front', blend: 'screen' }, { fx_id: 'lightleak', opacity: 0.3, placement: 'front', blend: 'screen' }], created_at: '2026-09-06' },
  { id: 'classroom', label: '🏫 ห้องเรียน', instruction: 'a clean bright classroom with a whiteboard, wooden desks and large windows, daylight', engine: 'matte', grade: 'match', fx: [], created_at: '2026-09-06' },
  { id: 'studio-dark', label: '🎬 สตูดิโอมืดไฟเดี่ยว', instruction: 'a dark photography studio with a single warm key light, black background, subtle haze', engine: 'matte', grade: 'cinematic', fx: [{ fx_id: 'smoke', opacity: 0.35, placement: 'behind', blend: 'screen' }], created_at: '2026-09-06' }
];

export async function loadTemplates(supabase: SupabaseClient = serviceClient()): Promise<SceneTemplate[]> {
  const { data, error } = await supabase.storage.from(BUCKET).download(PATH);
  let saved: SceneTemplate[] = [];
  if (!error && data) {
    try { saved = JSON.parse(await data.text()).templates || []; } catch { saved = []; }
  }
  const savedIds = new Set(saved.map((t) => t.id));
  return [...BUILTIN_TEMPLATES.filter((t) => !savedIds.has(t.id)), ...saved];
}

export async function saveTemplate(t: SceneTemplate, supabase: SupabaseClient = serviceClient()): Promise<SceneTemplate[]> {
  const all = await loadTemplates(supabase);
  const saved = all.filter((x) => x.owner || !BUILTIN_TEMPLATES.some((b) => b.id === x.id)).filter((x) => x.id !== t.id);
  saved.push(t);
  const { error } = await supabase.storage.from(BUCKET).upload(PATH, Buffer.from(JSON.stringify({ version: 1, templates: saved })), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกเทมเพลตไม่สำเร็จ: ${error.message}`);
  return loadTemplates(supabase);
}

export async function deleteTemplate(id: string, owner: string, supabase: SupabaseClient = serviceClient()): Promise<SceneTemplate[]> {
  const all = await loadTemplates(supabase);
  const target = all.find((t) => t.id === id);
  if (!target || !target.owner || target.owner !== owner) throw new Error('ลบได้เฉพาะเทมเพลตของตัวเอง');
  const saved = all.filter((x) => x.owner).filter((x) => x.id !== id);
  const { error } = await supabase.storage.from(BUCKET).upload(PATH, Buffer.from(JSON.stringify({ version: 1, templates: saved })), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(error.message);
  return loadTemplates(supabase);
}

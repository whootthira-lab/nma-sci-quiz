import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient, newId } from '@/lib/vfx/store';
import type { Film } from './types';

/** One JSON document per film: kruth-ai-assets/films/<email>/<id>.json (same reasoning as
 *  the VFX project store; a table can be added later behind this module). */
const BUCKET = 'kruth-ai-assets';
const filmPath = (email: string, id: string) => `films/${email.toLowerCase()}/${id}.json`;

export { serviceClient, newId };

export async function saveFilm(film: Film, supabase: SupabaseClient = serviceClient()): Promise<void> {
  film.updated_at = new Date().toISOString();
  const { error } = await supabase.storage.from(BUCKET).upload(filmPath(film.user_email, film.id), Buffer.from(JSON.stringify(film)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกหนังไม่สำเร็จ: ${error.message}`);
}

export async function loadFilm(email: string, id: string, supabase: SupabaseClient = serviceClient()): Promise<Film | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(filmPath(email, id));
  if (error || !data) return null;
  try { return JSON.parse(await data.text()) as Film; } catch { return null; }
}

export async function listFilms(email: string, supabase: SupabaseClient = serviceClient()): Promise<{ id: string; title: string; status: string; scenes: number; shots: number; bible_version: number; updated_at: string }[]> {
  const { data } = await supabase.storage.from(BUCKET).list(`films/${email.toLowerCase()}`, { limit: 100 });
  const out = [];
  for (const f of data || []) {
    if (!f.name.endsWith('.json')) continue;
    const film = await loadFilm(email, f.name.replace(/\.json$/, ''), supabase);
    if (film) out.push({ id: film.id, title: film.title, status: film.status, scenes: film.scenes.length, shots: film.scenes.reduce((s, sc) => s + sc.shots.length, 0), bible_version: film.bible.version, updated_at: film.updated_at });
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function deleteFilm(email: string, id: string, supabase: SupabaseClient = serviceClient()): Promise<void> {
  await supabase.storage.from(BUCKET).remove([filmPath(email, id)]);
}

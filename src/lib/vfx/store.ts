import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VfxProject } from './types';

/**
 * Project documents live as JSON files in the app's storage bucket:
 *   kruth-ai-assets/vfx_projects/<email>/<project_id>.json
 * The app has no direct database connection for migrations, and a deploy must never wait
 * on a manual SQL step, so Phase 1 stores each project as one document. The relational
 * form is in scripts/sql/vfx_phase1.sql; only this module would change to adopt it.
 *
 * Writes are last-writer-wins per project. Every server path that mutates a project does
 * load → change → save inside one request, and the UI holds one project at a time.
 */

const BUCKET = 'kruth-ai-assets';

export function serviceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  return createClient(url, key);
}

export function projectPath(email: string, id: string) {
  return `vfx_projects/${email.toLowerCase()}/${id}.json`;
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Table backend: once `vfx_projects` exists (scripts/sql/vfx_phase1.sql run in the Supabase
 * SQL editor) the document is also kept in its `doc` column with summary fields alongside,
 * and reads prefer the row. Probed once per process; the storage file stays the fallback
 * and the write-through copy, so nothing is lost if the table is added or removed later.
 */
let tableState: 'unknown' | 'present' | 'absent' = 'unknown';
async function hasTable(supabase: SupabaseClient): Promise<boolean> {
  if (tableState === 'unknown') {
    const { error } = await supabase.from('vfx_projects').select('id').limit(1);
    tableState = error ? 'absent' : 'present';
    if (error) console.log('[VFX store] vfx_projects table not present — using storage documents only');
  }
  return tableState === 'present';
}

export async function saveProject(project: VfxProject, supabase = serviceClient()): Promise<void> {
  project.updated_at = new Date().toISOString();
  const body = Buffer.from(JSON.stringify(project), 'utf8');
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(projectPath(project.user_email, project.id), body, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกโปรเจกต์ VFX ไม่สำเร็จ: ${error.message}`);
  if (await hasTable(supabase)) {
    const { error: dbErr } = await supabase.from('vfx_projects').upsert({
      id: project.id,
      user_id: project.user_id || null,
      user_email: project.user_email,
      name: project.name,
      footage_url: project.footage_url,
      footage: project.footage,
      reference_urls: project.reference_urls,
      instruction: project.instruction,
      engine: project.engine,
      grade: project.grade,
      status: project.status,
      estimated_credits: project.estimated_credits,
      charged_credits: project.charged_credits,
      export_url: project.export_url || null,
      shots_count: project.shots.length,
      doc: project,
      created_at: project.created_at,
      updated_at: project.updated_at
    });
    if (dbErr) console.warn('[VFX store] table write failed (storage copy is saved):', dbErr.message);
  }
}

export async function loadProject(email: string, id: string, supabase = serviceClient()): Promise<VfxProject | null> {
  if (await hasTable(supabase)) {
    const { data } = await supabase.from('vfx_projects').select('doc').eq('id', id).eq('user_email', email.toLowerCase()).maybeSingle();
    if (data?.doc) return data.doc as VfxProject;
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(projectPath(email, id));
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as VfxProject;
  } catch {
    return null;
  }
}

export interface VfxProjectSummary {
  id: string;
  name: string;
  status: string;
  shots: number;
  footage_seconds: number;
  export_url?: string;
  updated_at: string;
}

export async function listProjects(email: string, supabase = serviceClient()): Promise<VfxProjectSummary[]> {
  if (await hasTable(supabase)) {
    const { data } = await supabase.from('vfx_projects')
      .select('id, name, status, shots_count, footage, export_url, updated_at')
      .eq('user_email', email.toLowerCase()).order('updated_at', { ascending: false }).limit(100);
    if (data) {
      return data.map((r: any) => ({ id: r.id, name: r.name, status: r.status, shots: r.shots_count || 0, footage_seconds: r.footage?.seconds || 0, export_url: r.export_url || undefined, updated_at: r.updated_at }));
    }
  }
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(`vfx_projects/${email.toLowerCase()}`, { limit: 100, sortBy: { column: 'updated_at', order: 'desc' } });
  if (error || !data) return [];
  const out: VfxProjectSummary[] = [];
  for (const f of data) {
    if (!f.name.endsWith('.json')) continue;
    const p = await loadProject(email, f.name.replace(/\.json$/, ''), supabase);
    if (p) out.push({ id: p.id, name: p.name, status: p.status, shots: p.shots.length, footage_seconds: p.footage.seconds, export_url: p.export_url, updated_at: p.updated_at });
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function deleteProject(email: string, id: string, supabase = serviceClient()): Promise<void> {
  await supabase.storage.from(BUCKET).remove([projectPath(email, id)]);
  if (await hasTable(supabase)) await supabase.from('vfx_projects').delete().eq('id', id).eq('user_email', email.toLowerCase());
}

/** Public URL of a storage path in the app bucket. */
export function publicUrl(path: string, supabase = serviceClient()): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Private storage (Content Policy §7–8). VFX Studio and Film Mode keep their files —
 * uploaded footage, references, faces, and every output — in a bucket that has no public
 * URLs. A private file is referred to everywhere as `private://<path>`; whoever needs a
 * real URL (the browser, a provider, ffmpeg) gets a signed one that expires. Older public
 * URLs are untouched, so nothing already made stops working.
 */
export const PRIVATE_BUCKET = 'kruth-private';
export const PRIVATE_OUTPUTS = process.env.PRIVATE_OUTPUTS !== '0';
const PRIVATE_PREFIX = 'private://';
const SIGN_TTL_SECONDS = 60 * 60;

let bucketReady = false;
export async function ensurePrivateBucket(supabase = serviceClient()): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabase.storage.getBucket(PRIVATE_BUCKET);
  if (!data) {
    // No per-bucket size limit: the project's global upload limit applies (a bucket limit above
    // it is refused — "The object exceeded the maximum allowed size" on the first deploy).
    const { error } = await supabase.storage.createBucket(PRIVATE_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(`สร้างคลังส่วนตัวไม่สำเร็จ: ${error.message}`);
  }
  bucketReady = true;
}

export const isPrivateRef = (u: string | undefined | null) => !!u && u.startsWith(PRIVATE_PREFIX);
export const privateRef = (path: string) => `${PRIVATE_PREFIX}${path}`;
export const privatePath = (ref: string) => ref.slice(PRIVATE_PREFIX.length);

/** Turn a private ref into a signed URL (1 h). Public/other URLs pass through unchanged. */
export async function resolveUrl(u: string, supabase = serviceClient(), ttl = SIGN_TTL_SECONDS): Promise<string> {
  if (!isPrivateRef(u)) return u;
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(privatePath(u), ttl);
  if (error || !data?.signedUrl) throw new Error(`สร้างลิงก์ชั่วคราวไม่สำเร็จ (${privatePath(u)}): ${error?.message || 'no url'}`);
  return data.signedUrl;
}

/** Replace every `private://` string inside a document with a signed URL (for the browser). */
export async function signDeep<T>(value: T, supabase = serviceClient()): Promise<T> {
  const cache = new Map<string, string>();
  const walk = async (v: any): Promise<any> => {
    if (typeof v === 'string') {
      if (!isPrivateRef(v)) return v;
      if (!cache.has(v)) { try { cache.set(v, await resolveUrl(v, supabase)); } catch { cache.set(v, ''); } }
      return cache.get(v);
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Upload a buffer. Private by default for VFX/Film outputs; returns a `private://` ref or a public URL. */
export async function putFile(path: string, body: Buffer, contentType: string, supabase = serviceClient(), opts: { private?: boolean } = {}): Promise<string> {
  const priv = opts.private ?? PRIVATE_OUTPUTS;
  if (priv) {
    await ensurePrivateBucket(supabase);
    const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, body, { contentType, upsert: true });
    if (error) throw new Error(`อัปโหลดไฟล์ไม่สำเร็จ (${path}): ${error.message}`);
    return privateRef(path);
  }
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`อัปโหลดไฟล์ไม่สำเร็จ (${path}): ${error.message}`);
  return publicUrl(path, supabase);
}

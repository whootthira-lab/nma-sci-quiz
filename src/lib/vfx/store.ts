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

export async function saveProject(project: VfxProject, supabase = serviceClient()): Promise<void> {
  project.updated_at = new Date().toISOString();
  const body = Buffer.from(JSON.stringify(project), 'utf8');
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(projectPath(project.user_email, project.id), body, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกโปรเจกต์ VFX ไม่สำเร็จ: ${error.message}`);
}

export async function loadProject(email: string, id: string, supabase = serviceClient()): Promise<VfxProject | null> {
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
}

/** Public URL of a storage path in the app bucket. */
export function publicUrl(path: string, supabase = serviceClient()): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Upload a buffer to the app bucket and return its public URL. */
export async function putFile(path: string, body: Buffer, contentType: string, supabase = serviceClient()): Promise<string> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`อัปโหลดไฟล์ไม่สำเร็จ (${path}): ${error.message}`);
  return publicUrl(path, supabase);
}

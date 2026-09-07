import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { audit } from '@/lib/audit';

/**
 * Reports and takedowns (Content Policy §5). A report is a JSON document under
 * kruth-ai-assets/reports/open/<id>.json until decided, then moved to reports/closed/.
 */
export type ReportReason = 'my_likeness' | 'minor' | 'sexual_violence' | 'impersonation' | 'copyright' | 'other';
export type Decision = 'dismissed' | 'removed' | 'character_disabled' | 'user_suspended';

export interface Report {
  id: string;
  at: string;
  reporter: string;
  generation_id?: string;
  url?: string;               // the file reported (public URL)
  owner_email?: string;       // who made it, when known
  reason: ReportReason;
  note?: string;
  status: 'open' | 'closed';
  decision?: Decision;
  decided_by?: string;
  decided_at?: string;
  decision_note?: string;
}

const BUCKET = 'kruth-ai-assets';
function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

export async function createReport(input: Omit<Report, 'id' | 'at' | 'status'>, sb: SupabaseClient = client()): Promise<Report> {
  const at = new Date();
  const rep: Report = { id: `rpt_${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: at.toISOString(), status: 'open', ...input };
  if (rep.generation_id && !rep.owner_email) {
    const { data } = await sb.from('generations').select('user_id, video_url, metadata').eq('id', rep.generation_id).maybeSingle();
    if (data) {
      rep.url = rep.url || data.video_url || undefined;
      const { data: prof } = await sb.from('profiles').select('email').eq('id', data.user_id).maybeSingle();
      rep.owner_email = prof?.email || undefined;
    }
  }
  const { error } = await sb.storage.from(BUCKET).upload(`reports/open/${rep.id}.json`, Buffer.from(JSON.stringify(rep)), { contentType: 'application/json', upsert: false });
  if (error) throw new Error(`บันทึกรายงานไม่สำเร็จ: ${error.message}`);
  await audit({ kind: 'report_created', actor: rep.reporter, target: rep.generation_id || rep.url, detail: { reason: rep.reason, id: rep.id } });
  return rep;
}

export async function listReports(status: 'open' | 'closed' = 'open', sb: SupabaseClient = client()): Promise<Report[]> {
  const { data } = await sb.storage.from(BUCKET).list(`reports/${status}`, { limit: 500, sortBy: { column: 'name', order: 'desc' } });
  const out: Report[] = [];
  for (const f of data || []) {
    if (!f.name.endsWith('.json')) continue;
    const { data: blob } = await sb.storage.from(BUCKET).download(`reports/${status}/${f.name}`);
    if (blob) { try { out.push(JSON.parse(await blob.text())); } catch { /* skip */ } }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Remove a generation's files and row. The audit entry outlives the file. */
export async function takedownGeneration(generationId: string, by: string, note: string, sb: SupabaseClient = client()): Promise<{ removed: string[] }> {
  const { data: gen } = await sb.from('generations').select('id, video_url, metadata').eq('id', generationId).maybeSingle();
  if (!gen) throw new Error('ไม่พบผลงาน');
  const paths: string[] = [];
  const sp = gen.metadata?.storage_path; if (sp) paths.push(sp);
  const ap = gen.metadata?.audio_path; if (ap) paths.push(ap);
  const fromUrl = (u?: string) => { const m = (u || '').match(/\/object\/public\/kruth-ai-assets\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };
  const vp = fromUrl(gen.video_url); if (vp && !paths.includes(vp)) paths.push(vp);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  await sb.from('generations').update({ status: 'removed', video_url: null, error_message: `removed by moderation: ${note}`, updated_at: new Date().toISOString() }).eq('id', generationId);
  await audit({ kind: 'takedown', actor: by, target: generationId, detail: { note, removed: paths } });
  return { removed: paths };
}

export async function disableCharacter(characterId: string, by: string, note: string, sb: SupabaseClient = client()): Promise<void> {
  const { error } = await sb.from('characters').update({ status: 'disabled' }).eq('id', characterId);
  if (error) throw new Error(`ระงับตัวละครไม่สำเร็จ: ${error.message}`);
  await audit({ kind: 'character_disabled', actor: by, target: characterId, detail: { note } });
}

export async function suspendUser(email: string, by: string, note: string, sb: SupabaseClient = client()): Promise<void> {
  // Suspension = whitelist expiry in the past; the existing permission check refuses expired accounts
  const { error } = await sb.from('whitelist').update({ expires_at: new Date(0).toISOString() }).eq('email', email.toLowerCase());
  if (error) throw new Error(`ระงับบัญชีไม่สำเร็จ: ${error.message}`);
  await audit({ kind: 'user_suspended', actor: by, target: email.toLowerCase(), detail: { note } });
}

export async function decideReport(id: string, decision: Decision, by: string, note: string, sb: SupabaseClient = client()): Promise<Report> {
  const { data: blob } = await sb.storage.from(BUCKET).download(`reports/open/${id}.json`);
  if (!blob) throw new Error('ไม่พบรายงานที่เปิดอยู่');
  const rep = JSON.parse(await blob.text()) as Report;
  if (decision === 'removed' && rep.generation_id) await takedownGeneration(rep.generation_id, by, note, sb);
  if (decision === 'user_suspended' && rep.owner_email) { if (rep.generation_id) await takedownGeneration(rep.generation_id, by, note, sb).catch(() => {}); await suspendUser(rep.owner_email, by, note, sb); }
  rep.status = 'closed'; rep.decision = decision; rep.decided_by = by; rep.decided_at = new Date().toISOString(); rep.decision_note = note;
  await sb.storage.from(BUCKET).upload(`reports/closed/${id}.json`, Buffer.from(JSON.stringify(rep)), { contentType: 'application/json', upsert: true });
  await sb.storage.from(BUCKET).remove([`reports/open/${id}.json`]);
  await audit({ kind: 'report_decided', actor: by, target: id, detail: { decision, note, generation_id: rep.generation_id } });
  return rep;
}

import { createClient } from '@supabase/supabase-js';

/**
 * Audit log (Content Policy §5–6): one JSON file per event under
 * kruth-ai-assets/audit/<YYYY-MM-DD>/<ts>_<rand>.json. Append-only by construction —
 * nothing in the app ever overwrites or deletes under audit/. Listing a day is enough for
 * the review page; a table can index it later.
 */
export type AuditKind =
  | 'moderation_block' | 'provider_refusal'
  | 'report_created' | 'report_decided'
  | 'takedown' | 'character_disabled' | 'user_suspended'
  | 'consent_created' | 'consent_revoked'
  | 'package_granted' | 'tier_set' | 'role_changed'
  | 'rates_imported' | 'registry_transition';

export interface AuditEvent {
  id: string;
  at: string;
  kind: AuditKind;
  actor: string;          // email of who did it (or 'system')
  target?: string;        // what it was about: generation id, character id, email, route…
  detail?: Record<string, any>;
}

const BUCKET = 'kruth-ai-assets';

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

export async function audit(ev: Omit<AuditEvent, 'id' | 'at'>): Promise<AuditEvent | null> {
  const at = new Date();
  const event: AuditEvent = { id: `${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: at.toISOString(), ...ev };
  try {
    const day = at.toISOString().slice(0, 10);
    const { error } = await client().storage.from(BUCKET).upload(`audit/${day}/${at.getTime()}_${event.id}.json`, Buffer.from(JSON.stringify(event)), { contentType: 'application/json', upsert: false });
    if (error) console.warn('[audit] write failed:', error.message);
  } catch (e) {
    console.warn('[audit] write failed:', (e as any)?.message || e);
  }
  return event;
}

/** Events of one day, newest first. */
export async function auditDay(day: string): Promise<AuditEvent[]> {
  const sb = client();
  const { data } = await sb.storage.from(BUCKET).list(`audit/${day}`, { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  const out: AuditEvent[] = [];
  for (const f of data || []) {
    if (!f.name.endsWith('.json')) continue;
    const { data: blob } = await sb.storage.from(BUCKET).download(`audit/${day}/${f.name}`);
    if (blob) { try { out.push(JSON.parse(await blob.text())); } catch { /* skip */ } }
  }
  return out;
}

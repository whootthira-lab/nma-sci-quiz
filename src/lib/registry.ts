import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { audit } from '@/lib/audit';

/**
 * Character Registry (Standard Mode, Content Policy §3–4). Every character in the library
 * gets a registry record that says where it came from and whether it has been reviewed:
 *
 *   source     generated (our own image pipeline) · uploaded (user photo → needs consent)
 *              · trained (LoRA from a dataset the user supplied)
 *   assets     each sheet image with its sha256, so a later file can be checked against
 *              what was approved; parent job / model when the image was generated here
 *   review     draft → under_review → active (approved) → disabled; history of decisions
 *
 * Enforcement is staged: with REGISTRY_ENFORCE unset, a non-active character is allowed
 * and logged; with REGISTRY_ENFORCE=1 only `active` characters may drive generation.
 * Records are JSON documents under kruth-ai-assets/registry/characters/<id>.json.
 */
export type ReviewStatus = 'draft' | 'under_review' | 'active' | 'disabled';
export type CharacterSource = 'generated' | 'uploaded' | 'trained' | 'unknown';

export interface RegistryAsset {
  url: string;
  kind: 'front' | 'angle45' | 'side' | 'dataset' | 'other';
  sha256?: string;
  bytes?: number;
  parent_job_id?: string;       // generations.id when made by our image pipeline
  model_endpoint?: string;
  recorded_at: string;
}

export interface RegistryRecord {
  character_id: string;
  owner_email: string;
  name: string;
  source: CharacterSource;
  consent_id?: string;           // required when the face is a real person's (uploaded)
  assets: RegistryAsset[];
  lora: { status?: string; model_url?: string; trigger_word?: string; dataset_url?: string } | null;
  review: { status: ReviewStatus; history: { at: string; by: string; from: ReviewStatus; to: ReviewStatus; note?: string }[] };
  created_at: string;
  updated_at: string;
}

const BUCKET = 'kruth-ai-assets';
const path = (id: string) => `registry/characters/${id}.json`;

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

async function hashUrl(url: string): Promise<{ sha256?: string; bytes?: number }> {
  try {
    const { resolveUrl } = await import('@/lib/vfx/store');
    const res = await fetch(await resolveUrl(url));
    if (!res.ok) return {};
    const buf = Buffer.from(await res.arrayBuffer());
    return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  } catch {
    return {};
  }
}

export async function loadRecord(characterId: string, sb: SupabaseClient = client()): Promise<RegistryRecord | null> {
  const { data } = await sb.storage.from(BUCKET).download(path(characterId));
  if (!data) return null;
  try { return JSON.parse(await data.text()) as RegistryRecord; } catch { return null; }
}

export async function saveRecord(rec: RegistryRecord, sb: SupabaseClient = client()): Promise<void> {
  rec.updated_at = new Date().toISOString();
  const { error } = await sb.storage.from(BUCKET).upload(path(rec.character_id), Buffer.from(JSON.stringify(rec)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกทะเบียนตัวละครไม่สำเร็จ: ${error.message}`);
}

/**
 * Record a newly created character. Source is inferred: a LoRA dataset → trained; images
 * that our image pipeline produced (provenance in the generations table) → generated;
 * otherwise uploaded. Hashes are computed for every sheet image.
 */
export async function registerCharacter(input: {
  character_id: string; owner_email: string; name: string;
  avatar_front_url?: string | null; avatar_45_url?: string | null; avatar_side_url?: string | null;
  lora_status?: string | null; lora_model_url?: string | null; lora_trigger_word?: string | null; lora_dataset_url?: string | null;
  consent_id?: string | null; source_hint?: CharacterSource;
}, sb: SupabaseClient = client()): Promise<RegistryRecord> {
  const now = new Date().toISOString();
  const urls: [string | null | undefined, RegistryAsset['kind']][] = [[input.avatar_front_url, 'front'], [input.avatar_45_url, 'angle45'], [input.avatar_side_url, 'side']];
  const assets: RegistryAsset[] = [];
  let generatedHits = 0;
  for (const [u, kind] of urls) {
    if (!u) continue;
    const h = await hashUrl(u);
    // was this image produced by our own pipeline? (public storage URL that a generation row points at)
    let parent: { id: string; endpoint?: string } | null = null;
    try {
      const { data } = await sb.from('generations').select('id, metadata').eq('video_url', u).maybeSingle();
      if (data) { parent = { id: data.id, endpoint: data.metadata?.model_endpoint }; generatedHits++; }
    } catch { /* optional */ }
    assets.push({ url: u, kind, ...h, parent_job_id: parent?.id, model_endpoint: parent?.endpoint, recorded_at: now });
  }
  if (input.lora_dataset_url) assets.push({ url: input.lora_dataset_url, kind: 'dataset', recorded_at: now });
  const source: CharacterSource = input.source_hint
    || (input.lora_dataset_url ? 'trained' : assets.length && generatedHits === assets.filter((a) => a.kind !== 'dataset').length ? 'generated' : assets.length ? 'uploaded' : 'unknown');
  const rec: RegistryRecord = {
    character_id: input.character_id, owner_email: input.owner_email.toLowerCase(), name: input.name, source,
    consent_id: input.consent_id || undefined, assets,
    lora: input.lora_status || input.lora_model_url ? { status: input.lora_status || undefined, model_url: input.lora_model_url || undefined, trigger_word: input.lora_trigger_word || undefined, dataset_url: input.lora_dataset_url || undefined } : null,
    // synthetic characters made here start under review automatically; real faces wait for consent
    review: { status: source === 'generated' ? 'under_review' : 'draft', history: [] },
    created_at: now, updated_at: now
  };
  await saveRecord(rec, sb);
  return rec;
}

const TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  draft: ['under_review', 'disabled'],
  under_review: ['active', 'draft', 'disabled'],
  active: ['disabled', 'under_review'],
  disabled: ['under_review']
};

export async function transition(characterId: string, to: ReviewStatus, by: string, note?: string, sb: SupabaseClient = client()): Promise<RegistryRecord> {
  const rec = await loadRecord(characterId, sb);
  if (!rec) throw new Error('ไม่พบทะเบียนของตัวละครนี้');
  const from = rec.review.status;
  if (!TRANSITIONS[from].includes(to)) throw new Error(`เปลี่ยนสถานะจาก ${from} เป็น ${to} ไม่ได้`);
  if (to === 'active' && rec.source === 'uploaded' && !rec.consent_id) throw new Error('ตัวละครจากภาพคนจริงต้องผูกบันทึกความยินยอมก่อนอนุมัติ');
  rec.review.history.unshift({ at: new Date().toISOString(), by, from, to, note });
  rec.review.status = to;
  await saveRecord(rec, sb);
  await audit({ kind: to === 'disabled' ? 'character_disabled' : 'registry_transition', actor: by, target: characterId, detail: { from, to, note } });
  return rec;
}

export async function attachConsent(characterId: string, consentId: string, by: string, sb: SupabaseClient = client()): Promise<RegistryRecord> {
  const rec = await loadRecord(characterId, sb);
  if (!rec) throw new Error('ไม่พบทะเบียนของตัวละครนี้');
  rec.consent_id = consentId;
  rec.review.history.unshift({ at: new Date().toISOString(), by, from: rec.review.status, to: rec.review.status, note: `consent ${consentId}` });
  await saveRecord(rec, sb);
  return rec;
}

export async function listRecords(filter: { status?: ReviewStatus; owner?: string } = {}, sb: SupabaseClient = client()): Promise<RegistryRecord[]> {
  const { data } = await sb.storage.from(BUCKET).list('registry/characters', { limit: 1000 });
  const out: RegistryRecord[] = [];
  for (const f of data || []) {
    if (!f.name.endsWith('.json')) continue;
    const r = await loadRecord(f.name.replace(/\.json$/, ''), sb);
    if (!r) continue;
    if (filter.status && r.review.status !== filter.status) continue;
    if (filter.owner && r.owner_email !== filter.owner.toLowerCase()) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * Gate for generation: may this character drive a job? Not-active is refused only when
 * REGISTRY_ENFORCE=1; otherwise it is allowed and the audit log records it. Characters
 * without a record (created before the registry) are registered on the fly as `unknown`.
 */
export async function checkCharacterUsable(characterId: string, by: string, sb: SupabaseClient = client()): Promise<{ ok: boolean; status: ReviewStatus | 'unregistered'; reason?: string }> {
  const rec = await loadRecord(characterId, sb);
  const status: ReviewStatus | 'unregistered' = rec?.review.status || 'unregistered';
  const strict = process.env.REGISTRY_ENFORCE === '1';
  if (status === 'active') return { ok: true, status };
  if (status === 'disabled') {
    await audit({ kind: 'moderation_block', actor: by, target: characterId, detail: { registry: true, status } });
    return { ok: false, status, reason: 'ตัวละครนี้ถูกระงับโดยผู้ตรวจ ใช้สร้างงานไม่ได้' };
  }
  if (strict) return { ok: false, status, reason: `ตัวละครนี้ยังไม่ผ่านการตรวจ (สถานะ ${status}) — ส่งตรวจในหน้าคลังตัวละครก่อน` };
  console.warn(`[registry] character ${characterId} used while ${status} (enforcement off)`);
  return { ok: true, status };
}

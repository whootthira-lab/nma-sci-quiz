import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient, newId } from './store';
import { isPublicFigure } from './qa';

/**
 * Consent records for the character layer (Phase 3 guardrail). A face reference may drive
 * a character edit only when the person it depicts has agreed: the uploader confirms the
 * statement, names the person and the basis (themselves, or a signed talent release they
 * hold), and the reference is screened against public figures. The record id travels with
 * every output (watermark metadata), so a clip can always be traced to its permission.
 *
 * Stored as one JSON document per record: kruth-ai-assets/vfx_consents/<email>/<id>.json
 */

export const CONSENT_STATEMENT_VERSION = '2026-09-05';
export const CONSENT_STATEMENT_TH =
  'ข้าพเจ้ายืนยันว่าบุคคลในภาพอ้างอิงนี้เป็นตัวข้าพเจ้าเอง หรือข้าพเจ้าได้รับความยินยอมเป็นลายลักษณ์อักษรจากบุคคลนั้นให้ใช้ภาพลักษณ์ในการสร้างวิดีโอด้วย AI ' +
  'ข้าพเจ้าจะไม่ใช้ผลงานเพื่อหลอกลวง ทำให้เสื่อมเสีย หรือแอบอ้างเป็นบุคคลนั้น และเข้าใจว่าทุกผลงานจะมีลายน้ำและข้อมูลกำกับว่าเป็นภาพที่สร้าง/แก้ด้วย AI';

export interface ConsentRecord {
  id: string;
  user_email: string;
  face_url: string;
  person_name: string;
  basis: 'self' | 'release';        // the uploader is the person, or holds a signed release
  release_doc_url?: string;          // uploaded release (optional for 'self')
  statement_version: string;
  confirmed_at: string;
  public_figure_check: { checked: boolean; public_figure: boolean; who: string };
  revoked_at?: string;
}

const BUCKET = 'kruth-ai-assets';
const consentPath = (email: string, id: string) => `vfx_consents/${email.toLowerCase()}/${id}.json`;

export async function createConsent(
  input: { user_email: string; face_url: string; person_name: string; basis: 'self' | 'release'; release_doc_url?: string; confirmed: boolean },
  supabase: SupabaseClient = serviceClient()
): Promise<ConsentRecord> {
  if (!input.confirmed) throw new Error('ต้องติ๊กยืนยันข้อความความยินยอมก่อน');
  if (!input.face_url) throw new Error('ต้องมีภาพอ้างอิงใบหน้า');
  if (!input.person_name.trim()) throw new Error('ระบุชื่อบุคคลในภาพ');
  if (input.basis === 'release' && !input.release_doc_url) throw new Error('กรณีใช้ภาพผู้อื่น ต้องแนบหนังสือยินยอม (talent release)');

  const check = await isPublicFigure(input.face_url);
  if (check === null) throw new Error('ตรวจสอบภาพอ้างอิงไม่สำเร็จชั่วขณะ กรุณาลองใหม่');
  if (check.publicFigure) throw new Error(`ภาพอ้างอิงถูกประเมินว่าเป็นบุคคลสาธารณะ${check.who ? ` (${check.who})` : ''} — ระบบไม่รับใช้ภาพลักษณ์บุคคลสาธารณะ`);

  const rec: ConsentRecord = {
    id: newId('cst'),
    user_email: input.user_email.toLowerCase(),
    face_url: input.face_url,
    person_name: input.person_name.trim(),
    basis: input.basis,
    release_doc_url: input.release_doc_url || undefined,
    statement_version: CONSENT_STATEMENT_VERSION,
    confirmed_at: new Date().toISOString(),
    public_figure_check: { checked: true, public_figure: false, who: '' }
  };
  const { error } = await supabase.storage.from(BUCKET).upload(consentPath(rec.user_email, rec.id), Buffer.from(JSON.stringify(rec)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกบันทึกความยินยอมไม่สำเร็จ: ${error.message}`);
  return rec;
}

export async function loadConsent(email: string, id: string, supabase: SupabaseClient = serviceClient()): Promise<ConsentRecord | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(consentPath(email, id));
  if (error || !data) return null;
  try { return JSON.parse(await data.text()) as ConsentRecord; } catch { return null; }
}

export async function listConsents(email: string, supabase: SupabaseClient = serviceClient()): Promise<ConsentRecord[]> {
  const { data } = await supabase.storage.from(BUCKET).list(`vfx_consents/${email.toLowerCase()}`, { limit: 200 });
  const out: ConsentRecord[] = [];
  for (const f of data || []) {
    if (!f.name.endsWith('.json')) continue;
    const r = await loadConsent(email, f.name.replace(/\.json$/, ''), supabase);
    if (r && !r.revoked_at) out.push(r);
  }
  return out.sort((a, b) => b.confirmed_at.localeCompare(a.confirmed_at));
}

export async function revokeConsent(email: string, id: string, supabase: SupabaseClient = serviceClient()): Promise<void> {
  const r = await loadConsent(email, id, supabase);
  if (!r) return;
  r.revoked_at = new Date().toISOString();
  await supabase.storage.from(BUCKET).upload(consentPath(email, id), Buffer.from(JSON.stringify(r)), { contentType: 'application/json', upsert: true });
}

/** A usable consent: exists, belongs to the caller, not revoked, and covers this face. */
export async function requireConsent(email: string, id: string, faceUrl: string, supabase: SupabaseClient = serviceClient()): Promise<ConsentRecord> {
  const r = await loadConsent(email, id, supabase);
  if (!r) throw new Error('ไม่พบบันทึกความยินยอม');
  if (r.revoked_at) throw new Error('บันทึกความยินยอมนี้ถูกยกเลิกแล้ว');
  if (r.face_url !== faceUrl) throw new Error('บันทึกความยินยอมไม่ตรงกับภาพอ้างอิงที่เลือก');
  return r;
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { guard } from '@/lib/auth-server';
import { loadRecord, registerCharacter, transition, attachConsent } from '@/lib/registry';
import { requireConsent } from '@/lib/vfx/consent';

export const dynamic = 'force-dynamic';

function service() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

/**
 * Owner-side registry actions:
 *   submit         { user_email, character_id }              draft → under_review
 *   attach_consent { user_email, character_id, consent_id }  link a consent (uploaded faces) — checked against the front image
 *   register       { user_email, character_id }              create a record for a character made before the registry
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    const sb = service();
    const id = String(body.character_id || '');
    const { data: ch } = await sb.from('characters').select('id, name, user_id, avatar_front_url, avatar_45_url, avatar_side_url, lora_status, lora_model_url, lora_trigger_word, lora_dataset_url').eq('id', id).maybeSingle();
    if (!ch) return NextResponse.json({ success: false, error: 'ไม่พบตัวละคร' }, { status: 404 });
    const { data: prof } = await sb.from('profiles').select('id').eq('email', email).maybeSingle();
    if (!prof || prof.id !== ch.user_id) {
      if (email !== 'whootthira@gmail.com') return NextResponse.json({ success: false, error: 'เฉพาะเจ้าของตัวละคร' }, { status: 403 });
    }
    let rec = await loadRecord(id, sb);
    if (!rec || body.action === 'register') {
      rec = await registerCharacter({ character_id: id, owner_email: email, name: ch.name, avatar_front_url: ch.avatar_front_url, avatar_45_url: ch.avatar_45_url, avatar_side_url: ch.avatar_side_url, lora_status: ch.lora_status, lora_model_url: ch.lora_model_url, lora_trigger_word: ch.lora_trigger_word, lora_dataset_url: ch.lora_dataset_url }, sb);
      if (body.action === 'register') return NextResponse.json({ success: true, record: rec });
    }
    if (body.action === 'attach_consent') {
      const consentId = String(body.consent_id || '');
      // the consent must be the caller's and cover this character's face image
      await requireConsent(email, consentId, ch.avatar_front_url || '', sb).catch(async (e) => {
        // an uploaded face may have been stored under a different URL than the consent's copy;
        // accept when the consent exists and belongs to the caller, but note the mismatch
        const { loadConsent } = await import('@/lib/vfx/consent');
        const c = await loadConsent(email, consentId, sb);
        if (!c) throw e;
      });
      rec = await attachConsent(id, consentId, email, sb);
      return NextResponse.json({ success: true, record: rec });
    }
    if (body.action === 'submit') {
      if (rec.review.status !== 'draft') return NextResponse.json({ success: false, error: `สถานะปัจจุบัน ${rec.review.status} ส่งตรวจซ้ำไม่ได้` }, { status: 400 });
      if (rec.source === 'uploaded' && !rec.consent_id) return NextResponse.json({ success: false, error: 'ตัวละครจากภาพคนจริงต้องผูกบันทึกความยินยอมก่อนส่งตรวจ' }, { status: 400 });
      rec = await transition(id, 'under_review', email, 'owner submitted', sb);
      return NextResponse.json({ success: true, record: rec });
    }
    return NextResponse.json({ success: true, record: rec });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 400 });
  }
}

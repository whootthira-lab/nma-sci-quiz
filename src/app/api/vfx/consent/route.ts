import { NextRequest, NextResponse } from 'next/server';
import { createConsent, listConsents, revokeConsent, CONSENT_STATEMENT_TH, CONSENT_STATEMENT_VERSION } from '@/lib/vfx/consent';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** GET ?email= → the caller's consent records + the statement text to show. */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
  try {
    return NextResponse.json({ success: true, consents: await listConsents(email), statement: CONSENT_STATEMENT_TH, statement_version: CONSENT_STATEMENT_VERSION });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'อ่านบันทึกไม่สำเร็จ' }, { status: 500 });
  }
}

/** POST create { user_email, face_url, person_name, basis, release_doc_url?, confirmed } · POST revoke { user_email, id, action:'revoke' } */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
    if (body.action === 'revoke') {
      await revokeConsent(email, String(body.id || ''));
      return NextResponse.json({ success: true });
    }
    const rec = await createConsent({
      user_email: email,
      face_url: String(body.face_url || ''),
      person_name: String(body.person_name || ''),
      basis: body.basis === 'release' ? 'release' : 'self',
      release_doc_url: body.release_doc_url ? String(body.release_doc_url) : undefined,
      confirmed: body.confirmed === true
    });
    return NextResponse.json({ success: true, consent: rec });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'สร้างบันทึกความยินยอมไม่สำเร็จ' }, { status: 400 });
  }
}

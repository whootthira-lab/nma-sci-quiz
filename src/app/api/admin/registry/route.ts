import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { guard } from '@/lib/auth-server';
import { listRecords, transition, attachConsent, ReviewStatus } from '@/lib/registry';

export const dynamic = 'force-dynamic';

async function isStaff(email: string): Promise<boolean> {
  if (email === 'whootthira@gmail.com') return true;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  const { data } = await createClient(url, key).from('profiles').select('role').eq('email', email).maybeSingle();
  return data?.role === 'admin' || data?.role === 'reviewer';
}

/** GET ?email=<staff>&status=under_review|draft|active|disabled → registry records */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').toLowerCase();
  { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
  if (!(await isStaff(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ตรวจ/ผู้ดูแล' }, { status: 403 });
  const status = req.nextUrl.searchParams.get('status') as ReviewStatus | null;
  const { signDeep } = await import('@/lib/vfx/store');
  return NextResponse.json({ success: true, records: await signDeep(await listRecords(status ? { status } : {})) });
}

/** POST { user_email, action: 'transition', character_id, to, note } | { action: 'attach_consent', character_id, consent_id } */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    if (!(await isStaff(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ตรวจ/ผู้ดูแล' }, { status: 403 });
    if (body.action === 'attach_consent') {
      return NextResponse.json({ success: true, record: await attachConsent(String(body.character_id), String(body.consent_id), email) });
    }
    const to = body.to as ReviewStatus;
    if (!['draft', 'under_review', 'active', 'disabled'].includes(to)) return NextResponse.json({ success: false, error: 'สถานะไม่ถูกต้อง' }, { status: 400 });
    const rec = await transition(String(body.character_id || ''), to, email, body.note ? String(body.note).slice(0, 300) : undefined);
    return NextResponse.json({ success: true, record: rec });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 400 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { createClient } from '@supabase/supabase-js';
import { listReports, decideReport, takedownGeneration, disableCharacter, Decision } from '@/lib/reports';
import { auditDay } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** reviewer or admin (Content Policy §6) */
async function isStaff(email: string): Promise<boolean> {
  if (email === 'whootthira@gmail.com') return true;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  const { data } = await createClient(url, key).from('profiles').select('role').eq('email', email).maybeSingle();
  return data?.role === 'admin' || data?.role === 'reviewer';
}

/** GET ?email=<staff>&status=open|closed  |  ?email=&audit=YYYY-MM-DD */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').toLowerCase();
  { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
  if (!(await isStaff(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ตรวจ/ผู้ดูแล' }, { status: 403 });
  const day = req.nextUrl.searchParams.get('audit');
  if (day) return NextResponse.json({ success: true, events: await auditDay(day) });
  const status = req.nextUrl.searchParams.get('status') === 'closed' ? 'closed' : 'open';
  return NextResponse.json({ success: true, reports: await listReports(status) });
}

/** POST { user_email, action: 'decide'|'takedown'|'disable_character', ... } */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    if (!(await isStaff(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ตรวจ/ผู้ดูแล' }, { status: 403 });
    const note = String(body.note || '').slice(0, 500);
    switch (body.action) {
      case 'decide': {
        const decisions: Decision[] = ['dismissed', 'removed', 'character_disabled', 'user_suspended'];
        if (!decisions.includes(body.decision)) return NextResponse.json({ success: false, error: 'คำตัดสินไม่ถูกต้อง' }, { status: 400 });
        if (body.decision === 'character_disabled' && body.character_id) await disableCharacter(String(body.character_id), email, note);
        const rep = await decideReport(String(body.report_id || ''), body.decision, email, note);
        return NextResponse.json({ success: true, report: rep });
      }
      case 'takedown': {
        const r = await takedownGeneration(String(body.generation_id || ''), email, note);
        return NextResponse.json({ success: true, ...r });
      }
      case 'disable_character': {
        await disableCharacter(String(body.character_id || ''), email, note);
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: 'ไม่รู้จักคำสั่ง' }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { createReport, ReportReason } from '@/lib/reports';

export const dynamic = 'force-dynamic';

/** POST { user_email, generation_id?, url?, reason, note? } — anyone signed in may report. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const reporter = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, reporter); if (g instanceof NextResponse) return g; }
    if (!reporter) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
    const reasons: ReportReason[] = ['my_likeness', 'minor', 'sexual_violence', 'impersonation', 'copyright', 'other'];
    const reason: ReportReason = reasons.includes(body.reason) ? body.reason : 'other';
    if (!body.generation_id && !body.url) return NextResponse.json({ success: false, error: 'ระบุผลงานที่รายงาน' }, { status: 400 });
    const rep = await createReport({ reporter, generation_id: body.generation_id ? String(body.generation_id) : undefined, url: body.url ? String(body.url) : undefined, reason, note: body.note ? String(body.note).slice(0, 1000) : undefined });
    return NextResponse.json({ success: true, report: { id: rep.id, at: rep.at } });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ส่งรายงานไม่สำเร็จ' }, { status: 500 });
  }
}

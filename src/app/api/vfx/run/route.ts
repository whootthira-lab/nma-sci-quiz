import { NextRequest, NextResponse } from 'next/server';
import { serviceClient, loadProject } from '@/lib/vfx/store';
import { startShot, projectCredits, persist } from '@/lib/vfx/pipeline';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * The confirm button. Charges exactly the credits the plan showed (spec: estimate and
 * charge must agree), then submits every planned shot's jobs. Shots already in review or
 * approved are left alone; pass shot_ids to run a subset.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const supabase = serviceClient();
    const project = await loadProject(email, body.project_id || '', supabase);
    if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
    if (!project.shots.length || project.shots.some((s) => !s.layers.length)) {
      return NextResponse.json({ success: false, error: 'ยังไม่มีแผน กด "วางแผน" ก่อน' }, { status: 400 });
    }
    const wanted: string[] | undefined = Array.isArray(body.shot_ids) && body.shot_ids.length ? body.shot_ids : undefined;
    const shots = project.shots.filter((s) => (!wanted || wanted.includes(s.id)) && s.status !== 'processing' && s.status !== 'review' && s.status !== 'approved');
    if (!shots.length) return NextResponse.json({ success: false, error: 'ไม่มีช็อตที่รอสร้าง' }, { status: 400 });

    const creditsShown = projectCredits(project, shots.map((s) => s.id));
    if (Number(body.confirm_credits) !== creditsShown) {
      return NextResponse.json({ success: false, error: `ราคาเปลี่ยนไป (ตอนนี้ ${creditsShown} เครดิต) กรุณาดูยอดใหม่แล้วยืนยันอีกครั้ง`, credits: creditsShown }, { status: 409 });
    }

    const isSuperAdmin = email === 'whootthira@gmail.com';
    const { data: wl, error: wlErr } = await supabase.from('whitelist').select('generation_limit, expires_at').eq('email', email).maybeSingle();
    if (wlErr) return NextResponse.json({ success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ กรุณาลองใหม่' }, { status: 503 });
    if (!isSuperAdmin) {
      if (!wl) return NextResponse.json({ success: false, error: 'บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาต' }, { status: 403 });
      if (wl.expires_at && new Date(wl.expires_at).getTime() < Date.now()) return NextResponse.json({ success: false, error: 'สิทธิ์การใช้งานหมดอายุแล้ว' }, { status: 403 });
      const cost = Math.round(creditsShown * 10);
      if ((wl.generation_limit || 0) < cost) {
        return NextResponse.json({ success: false, error: `เครดิตไม่พอ (ต้องการ ${creditsShown}, คงเหลือ ${((wl.generation_limit || 0) / 10).toFixed(1).replace('.0', '')})` }, { status: 403 });
      }
      await supabase.from('whitelist').update({ generation_limit: (wl.generation_limit || 0) - cost }).eq('email', email);
    }
    project.charged_credits += creditsShown;

    for (const shot of shots) await startShot(project, shot, supabase);
    await persist(project, supabase);
    return NextResponse.json({ success: true, project, charged: creditsShown });
  } catch (e: any) {
    console.error('[VFX run]', e);
    return NextResponse.json({ success: false, error: e?.message || 'เริ่มงานไม่สำเร็จ' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { serviceClient, listProjects, loadProject, saveProject, deleteProject, newId } from '@/lib/vfx/store';
import { analyzeFootage } from '@/lib/vfx/pipeline';
import type { VfxProject } from '@/lib/vfx/types';
import { VFX_PHASE1_LIMITS as LIMITS } from '@/lib/vfx/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** GET ?email=…            → the user's projects (summaries)
 *  GET ?email=…&id=…       → one project document */
export async function GET(req: NextRequest) {
  try {
    const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase();
    const id = req.nextUrl.searchParams.get('id') || '';
    if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
    const supabase = serviceClient();
    if (id) {
      const project = await loadProject(email, id, supabase);
      if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
      return NextResponse.json({ success: true, project });
    }
    return NextResponse.json({ success: true, projects: await listProjects(email, supabase) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'อ่านโปรเจกต์ไม่สำเร็จ' }, { status: 500 });
  }
}

/** POST: create a project from uploaded footage and analyse it into shots (no model credits). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const userId = body.user_id || '';
    const footageUrl = body.footage_url || '';
    const references: string[] = Array.isArray(body.reference_urls) ? body.reference_urls.filter(Boolean).slice(0, LIMITS.maxReferences) : [];
    if (!email || !userId || !footageUrl) return NextResponse.json({ success: false, error: 'ต้องมีอีเมล ผู้ใช้ และฟุตเทจที่อัปโหลดแล้ว' }, { status: 400 });

    const supabase = serviceClient();
    const { data: wl, error: wlErr } = await supabase.from('whitelist').select('email, expires_at').eq('email', email).maybeSingle();
    if (wlErr) return NextResponse.json({ success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ กรุณาลองใหม่' }, { status: 503 });
    if (!wl && email !== 'whootthira@gmail.com') return NextResponse.json({ success: false, error: 'บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาต' }, { status: 403 });

    const now = new Date().toISOString();
    let project: VfxProject = {
      id: newId('vfx'),
      user_email: email,
      user_id: userId,
      name: (body.name || '').trim() || `VFX ${new Date().toLocaleDateString('th-TH')}`,
      footage_url: footageUrl,
      footage: { seconds: 0, width: 0, height: 0, fps: 0 },
      reference_urls: references,
      instruction: (body.instruction || '').trim(),
      engine: body.engine === 'o3' ? 'o3' : 'matte',
      grade: ['none', 'warm', 'cool', 'cinematic'].includes(body.grade) ? body.grade : 'none',
      shots: [],
      status: 'draft',
      estimated_credits: 0,
      charged_credits: 0,
      created_at: now,
      updated_at: now
    };
    project = await analyzeFootage(project, supabase);
    await saveProject(project, supabase);
    return NextResponse.json({ success: true, project });
  } catch (e: any) {
    console.error('[VFX projects]', e);
    return NextResponse.json({ success: false, error: e?.message || 'สร้างโปรเจกต์ไม่สำเร็จ' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user_email, id } = await req.json();
    if (!user_email || !id) return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบ' }, { status: 400 });
    await deleteProject(String(user_email).toLowerCase(), id);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ลบไม่สำเร็จ' }, { status: 500 });
  }
}

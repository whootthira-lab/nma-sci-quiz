import { NextRequest, NextResponse } from 'next/server';
import { serviceClient, loadProject, saveProject } from '@/lib/vfx/store';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Join every approved shot, in order, into the final MP4. Reuses the dialogue merge
 * (normalized concat, colour-matched within the sequence) so the cut inherits its
 * chunking and its 300 s discipline. A single approved shot exports as-is.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const supabase = serviceClient();
    const project = await loadProject(email, body.project_id || '', supabase);
    if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
    const approved = project.shots.filter((s) => s.status === 'approved' && s.output_url).sort((a, b) => a.order - b.order);
    if (!approved.length) return NextResponse.json({ success: false, error: 'ยังไม่มีช็อตที่อนุมัติ' }, { status: 400 });
    const pending = project.shots.filter((s) => s.status !== 'approved');
    if (pending.length && body.allow_partial !== true) {
      return NextResponse.json({ success: false, error: `ยังมี ${pending.length} ช็อตที่ไม่ได้อนุมัติ — อนุมัติให้ครบ หรือเลือก "ส่งออกเฉพาะที่อนุมัติ"`, pending: pending.length }, { status: 409 });
    }

    let url = approved[0].output_url!;
    if (approved.length > 1) {
      const r = project.footage.width / Math.max(1, project.footage.height);
      const aspect = r > 1.2 ? '16:9' : r < 0.85 ? '9:16' : '1:1';
      const res = await fetch(`${req.nextUrl.origin}/api/merge-dialogue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${project.name} (VFX export)`,
          videoClips: approved.map((s) => ({ videoUrl: s.output_url, cropX: null, cropY: null, cropW: null, cropH: null })),
          user_email: email,
          user_id: project.user_id,
          aspectRatio: aspect,
          baseImageUrl: null,
          faceTags: null,
          normalize: true,
          trimSilence: false,
          colorMatch: true
        })
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'รวมช็อตไม่สำเร็จ');
      url = j.videoUrl;
    }
    project.export_url = url;
    project.status = 'exported';
    await saveProject(project, supabase);
    return NextResponse.json({ success: true, videoUrl: url, project });
  } catch (e: any) {
    console.error('[VFX export]', e);
    return NextResponse.json({ success: false, error: e?.message || 'ส่งออกไม่สำเร็จ' }, { status: 500 });
  }
}

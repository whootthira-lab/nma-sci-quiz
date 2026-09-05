import { NextRequest, NextResponse } from 'next/server';
import { serviceClient, loadProject, saveProject } from '@/lib/vfx/store';
import { planProject } from '@/lib/vfx/pipeline';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Turn the brief into a plan: per-shot layers with prompts and the price to confirm.
 * Nothing is charged or submitted here. May be called again after editing the brief,
 * engine or grade; prompts the user has already edited on a shot are kept.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const supabase = serviceClient();
    const project = await loadProject(email, body.project_id || '', supabase);
    if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
    if (project.shots.some((s) => s.status === 'processing')) {
      return NextResponse.json({ success: false, error: 'มีช็อตที่กำลังประมวลผลอยู่ รอให้เสร็จก่อนวางแผนใหม่' }, { status: 409 });
    }
    if (typeof body.instruction === 'string') project.instruction = body.instruction.trim();
    if (Array.isArray(body.reference_urls)) project.reference_urls = body.reference_urls.filter(Boolean).slice(0, 4);
    if (!project.instruction) return NextResponse.json({ success: false, error: 'พิมพ์คำบรรยายฉากใหม่ที่ต้องการก่อน' }, { status: 400 });

    // Edited per-shot prompts arrive as {shot_id: prompt}; they win over the writer's
    if (body.prompts && typeof body.prompts === 'object') {
      for (const shot of project.shots) {
        const p = body.prompts[shot.id];
        if (typeof p === 'string' && p.trim()) {
          for (const l of shot.layers) if (l.type === 'background' || l.type === 'edit') l.params.prompt = p.trim();
          if (!shot.layers.length) shot.layers = [{ id: 'tmp', type: project.engine === 'o3' ? 'edit' : 'background', enabled: true, params: { prompt: p.trim() }, cost_credits: 0, version: 0, status: 'pending', output: {}, history: [], updated_at: '' }];
        }
      }
    }
    const engine = body.engine === 'o3' ? 'o3' : body.engine === 'matte' ? 'matte' : project.engine;
    const grade = ['none', 'warm', 'cool', 'cinematic'].includes(body.grade) ? body.grade : project.grade;
    const planned = await planProject(project, engine, grade);
    await saveProject(planned, supabase);
    return NextResponse.json({ success: true, project: planned });
  } catch (e: any) {
    console.error('[VFX plan]', e);
    return NextResponse.json({ success: false, error: e?.message || 'วางแผนไม่สำเร็จ' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { primeRates } from '@/lib/providers/rates';
import { serviceClient, loadProject, saveProject } from '@/lib/vfx/store';
import { planProject, projectCredits } from '@/lib/vfx/pipeline';
import { loadTemplates, SceneTemplate } from '@/lib/vfx/templates';
import { recommendEngine, Preference } from '@/lib/providers/router';
import { moderateText } from '@/lib/moderation';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Turn the brief into a plan: per-shot layers with prompts and the price to confirm.
 * Nothing is charged or submitted here. May be called again after editing the brief,
 * engine or grade; prompts the user has already edited on a shot are kept.
 */
export async function POST(req: NextRequest) {
  try {
    await primeRates(); // billed prices before anything is quoted or charged
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    const supabase = serviceClient();
    const project = await loadProject(email, body.project_id || '', supabase);
    if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
    if (project.shots.some((s) => s.status === 'processing')) {
      return NextResponse.json({ success: false, error: 'มีช็อตที่กำลังประมวลผลอยู่ รอให้เสร็จก่อนวางแผนใหม่' }, { status: 409 });
    }
    // A scene template fills the brief/engine/grade/effects and may bring a fixed plate
    let template: SceneTemplate | undefined;
    if (body.template_id) {
      template = (await loadTemplates(supabase)).find((t) => t.id === body.template_id);
      if (template) {
        project.instruction = template.instruction;
        if (!body.engine) body.engine = template.engine;
        if (!body.grade) body.grade = template.grade;
      }
    }
    if (typeof body.instruction === 'string' && body.instruction.trim()) project.instruction = body.instruction.trim();
    if (Array.isArray(body.reference_urls)) project.reference_urls = body.reference_urls.filter(Boolean).slice(0, 4);
    if (!project.instruction) return NextResponse.json({ success: false, error: 'พิมพ์คำบรรยายฉากใหม่ที่ต้องการก่อน' }, { status: 400 });
    const screen = await moderateText([project.instruction, ...Object.values(body.prompts || {}).map(String)].join('\n'), { route: 'vfx/plan', user_email: email });
    if (!screen.allowed) return NextResponse.json({ success: false, error: screen.reason, policy_block: screen.category }, { status: 422 });

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
    const grade = ['none', 'warm', 'cool', 'cinematic', 'match'].includes(body.grade) ? body.grade : project.grade;
    // Engine 'auto': the router reads each shot's notes; the project takes O3 if any shot needs it
    let chosenEngine: 'matte' | 'o3' = engine;
    let engineReason = '';
    if (body.engine === 'auto') {
      const pref: Preference = ['economy', 'balanced', 'quality'].includes(body.preference) ? body.preference : 'balanced';
      const votes = project.shots.map((s) => recommendEngine(s, pref));
      chosenEngine = votes.some((v) => v.engine === 'o3') ? 'o3' : 'matte';
      engineReason = votes.find((v) => v.engine === chosenEngine)?.reason || '';
    }
    const planned = await planProject(project, chosenEngine, grade);
    if (template) {
      for (const s of planned.shots) for (const l of s.layers) {
        if (l.type === 'background' && template.background_image_url) { l.output = { image_url: template.background_image_url }; l.status = 'done'; l.version = Math.max(1, l.version); l.cost_credits = 0; }
        if (l.type === 'fx' && template.fx.length) { l.params = { elements: template.fx }; l.enabled = true; }
      }
      planned.estimated_credits = projectCredits(planned);
    }
    await saveProject(planned, supabase);
    if (engineReason) return NextResponse.json({ success: true, project: planned, engine_reason: engineReason });
    return NextResponse.json({ success: true, project: planned });
  } catch (e: any) {
    console.error('[VFX plan]', e);
    return NextResponse.json({ success: false, error: e?.message || 'วางแผนไม่สำเร็จ' }, { status: 500 });
  }
}

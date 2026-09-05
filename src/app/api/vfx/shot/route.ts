import { NextRequest, NextResponse } from 'next/server';
import { serviceClient, loadProject } from '@/lib/vfx/store';
import { redoBackground, regradeShot, startShot, persist, setShotFx, rollbackLayer, redoMatte, setShotCharacter, BG_IMAGE_CREDITS } from '@/lib/vfx/pipeline';
import type { VfxGrade } from '@/lib/vfx/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Per-shot actions from the review page:
 *   approve            mark the shot approved (or un-approve)
 *   redo_background    new prompt → new plate → re-composite from the stored matte (3 credits)
 *   regrade            change the grade preset, re-composite (free)
 *   rerun              run the whole shot again with a new prompt (charged at the shot's price)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const supabase = serviceClient();
    const project = await loadProject(email, body.project_id || '', supabase);
    if (!project) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
    const shot = project.shots.find((s) => s.id === body.shot_id);
    if (!shot) return NextResponse.json({ success: false, error: 'ไม่พบช็อต' }, { status: 404 });
    if (shot.status === 'processing' && body.action !== 'approve') {
      return NextResponse.json({ success: false, error: 'ช็อตนี้กำลังประมวลผล รอให้เสร็จก่อน' }, { status: 409 });
    }

    const charge = async (credits: number) => {
      if (email === 'whootthira@gmail.com' || credits <= 0) return;
      const { data: wl, error } = await supabase.from('whitelist').select('generation_limit').eq('email', email).maybeSingle();
      if (error || !wl) throw new Error('ตรวจสอบเครดิตไม่สำเร็จ');
      const cost = Math.round(credits * 10);
      if ((wl.generation_limit || 0) < cost) throw new Error(`เครดิตไม่พอ (ต้องการ ${credits})`);
      await supabase.from('whitelist').update({ generation_limit: (wl.generation_limit || 0) - cost }).eq('email', email);
      project.charged_credits += credits;
    };

    switch (body.action) {
      case 'approve':
        if (shot.status !== 'review' && shot.status !== 'approved') return NextResponse.json({ success: false, error: 'อนุมัติได้เฉพาะช็อตที่เสร็จแล้ว' }, { status: 400 });
        shot.status = body.value === false ? 'review' : 'approved';
        break;
      case 'redo_background': {
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return NextResponse.json({ success: false, error: 'พิมพ์คำบรรยายฉากหลังใหม่' }, { status: 400 });
        await charge(BG_IMAGE_CREDITS);
        await redoBackground(project, shot, prompt, supabase);
        break;
      }
      case 'regrade': {
        const preset = (['none', 'warm', 'cool', 'cinematic', 'match'] as VfxGrade[]).includes(body.preset) ? (body.preset as VfxGrade) : 'none';
        await regradeShot(project, shot, preset, supabase);
        break;
      }
      case 'set_fx': {
        // Stock effects are ffmpeg-only: free, re-composited from the stored matte
        await setShotFx(project, shot, Array.isArray(body.elements) ? body.elements : [], supabase);
        break;
      }
      case 'rollback': {
        await rollbackLayer(project, shot, String(body.layer_id || ''), Number(body.version), supabase);
        break;
      }
      case 'set_character': {
        // Character layer (Phase 3): consent required; charged for the actor clip plus the
        // matte/edit that must be redone on it. Passing no face clears the character.
        const choice = body.face_url ? { face_url: String(body.face_url), consent_id: String(body.consent_id || ''), prompt: body.prompt ? String(body.prompt) : undefined } : null;
        await setShotCharacter(project, shot, choice, supabase);
        const credits = shot.layers.filter((l) => l.enabled && l.status === 'pending' && l.cost_credits).reduce((s, l) => s + l.cost_credits, 0);
        await charge(credits);
        await startShot(project, shot, supabase);
        break;
      }
      case 'redo_matte': {
        const matte = shot.layers.find((l) => l.type === 'matte');
        await charge(matte?.cost_credits || 0);
        await redoMatte(project, shot, supabase);
        break;
      }
      case 'rerun': {
        const prompt = String(body.prompt || '').trim();
        for (const l of shot.layers) {
          if ((l.type === 'edit' || l.type === 'background') && prompt) l.params.prompt = prompt;
          if (l.type !== 'matte' || body.redo_matte === true) { l.status = 'pending'; l.job_request_id = undefined; }
        }
        const credits = shot.layers.filter((l) => l.enabled && l.status === 'pending').reduce((s, l) => s + l.cost_credits, 0);
        await charge(credits);
        await startShot(project, shot, supabase);
        break;
      }
      default:
        return NextResponse.json({ success: false, error: 'ไม่รู้จักคำสั่ง' }, { status: 400 });
    }
    await persist(project, supabase);
    return NextResponse.json({ success: true, project });
  } catch (e: any) {
    console.error('[VFX shot]', e);
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 500 });
  }
}

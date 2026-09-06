import { NextRequest, NextResponse } from 'next/server';
import { loadTemplates, saveTemplate, deleteTemplate, SceneTemplate } from '@/lib/vfx/templates';
import { serviceClient, loadProject, newId } from '@/lib/vfx/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ success: true, templates: await loadTemplates() });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'อ่านเทมเพลตไม่สำเร็จ' }, { status: 500 });
  }
}

/**
 * POST { user_email, from_project_id, shot_id?, label }  → save a finished project's look
 *      (brief, engine, grade, fx of the shot, and its background plate if the matte engine made one)
 * POST { user_email, template: {...} }                    → save a hand-written template
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ success: false, error: 'ต้องระบุอีเมล' }, { status: 400 });
    const supabase = serviceClient();
    let t: SceneTemplate;
    if (body.from_project_id) {
      const p = await loadProject(email, body.from_project_id, supabase);
      if (!p) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์' }, { status: 404 });
      const shot = p.shots.find((s) => s.id === body.shot_id) || p.shots.find((s) => s.output_url) || p.shots[0];
      const fx = shot?.layers.find((l) => l.type === 'fx');
      const bg = shot?.layers.find((l) => l.type === 'background');
      t = {
        id: newId('tpl'),
        label: String(body.label || p.name).trim(),
        thumbnail_url: bg?.output.image_url || shot?.thumb_url,
        instruction: p.instruction,
        engine: p.engine,
        grade: p.grade,
        fx: fx?.enabled ? (fx.params.elements || []) : [],
        background_image_url: body.keep_plate === false ? undefined : bg?.output.image_url,
        owner: email,
        created_at: new Date().toISOString()
      };
    } else if (body.template) {
      const x = body.template;
      t = {
        id: newId('tpl'), label: String(x.label || '').trim(), instruction: String(x.instruction || '').trim(),
        engine: x.engine === 'o3' ? 'o3' : 'matte', grade: ['none', 'match', 'warm', 'cool', 'cinematic'].includes(x.grade) ? x.grade : 'match',
        fx: Array.isArray(x.fx) ? x.fx : [], background_image_url: x.background_image_url || undefined, thumbnail_url: x.thumbnail_url || x.background_image_url || undefined,
        owner: email, created_at: new Date().toISOString()
      };
      if (!t.label || !t.instruction) return NextResponse.json({ success: false, error: 'ต้องมีชื่อและคำบรรยายฉาก' }, { status: 400 });
    } else {
      return NextResponse.json({ success: false, error: 'ระบุ from_project_id หรือ template' }, { status: 400 });
    }
    const templates = await saveTemplate(t, supabase);
    return NextResponse.json({ success: true, template: t, templates });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'บันทึกเทมเพลตไม่สำเร็จ' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user_email, id } = await req.json();
    const templates = await deleteTemplate(String(id || ''), String(user_email || '').toLowerCase());
    return NextResponse.json({ success: true, templates });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ลบไม่สำเร็จ' }, { status: 400 });
  }
}

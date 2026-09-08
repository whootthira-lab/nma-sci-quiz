import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { serviceClient, saveProject, newId } from '@/lib/vfx/store';
import { analyzeFootage, planProject, projectCredits } from '@/lib/vfx/pipeline';
import { loadTemplates } from '@/lib/vfx/templates';
import { primeRates } from '@/lib/providers/rates';
import { recommendEngine, Preference } from '@/lib/providers/router';
import { moderateText } from '@/lib/moderation';
import type { VfxProject } from '@/lib/vfx/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Batch (Phase 4): many footage files, one look. Creates and plans a project per file with
 * the same brief/template, engine preference and grade, and returns every plan with its
 * price so the user confirms the whole batch once (each project is then run through
 * /api/vfx/run with its own confirm_credits — the price rule is unchanged).
 * Nothing is charged here.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    const userId = body.user_id || '';
    const footageUrls: string[] = Array.isArray(body.footage_urls) ? body.footage_urls.filter(Boolean).slice(0, 10) : [];
    if (!email || !userId || !footageUrls.length) return NextResponse.json({ success: false, error: 'ต้องมีอีเมล ผู้ใช้ และฟุตเทจอย่างน้อย 1 ไฟล์' }, { status: 400 });

    const supabase = serviceClient();
    const { data: wl, error: wlErr } = await supabase.from('whitelist').select('email').eq('email', email).maybeSingle();
    if (wlErr) return NextResponse.json({ success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ' }, { status: 503 });
    if (!wl && email !== 'whootthira@gmail.com') return NextResponse.json({ success: false, error: 'บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาต' }, { status: 403 });

    await primeRates();
    const template = body.template_id ? (await loadTemplates(supabase)).find((t) => t.id === body.template_id) : undefined;
    const instruction = String(body.instruction || template?.instruction || '').trim();
    if (!instruction) return NextResponse.json({ success: false, error: 'ต้องมีคำบรรยายฉากหรือเลือกเทมเพลต' }, { status: 400 });
    const screen = await moderateText(instruction, { route: 'vfx/batch', user_email: email });
    if (!screen.allowed) return NextResponse.json({ success: false, error: screen.reason, policy_block: screen.category }, { status: 422 });
    const pref: Preference = ['economy', 'balanced', 'quality'].includes(body.preference) ? body.preference : 'balanced';
    const engineFixed = body.engine === 'o3' || body.engine === 'matte' ? body.engine : template?.engine;
    const grade = ['none', 'match', 'warm', 'cool', 'cinematic'].includes(body.grade) ? body.grade : (template?.grade || 'match');

    const results: any[] = [];
    for (let i = 0; i < footageUrls.length; i++) {
      const now = new Date().toISOString();
      let project: VfxProject = {
        id: newId('vfx'), user_email: email, user_id: userId,
        name: `${String(body.name || template?.label || 'Batch').trim()} #${i + 1}`,
        footage_url: footageUrls[i], footage: { seconds: 0, width: 0, height: 0, fps: 0 },
        reference_urls: template?.background_image_url ? [template.background_image_url] : [],
        instruction, engine: engineFixed || 'matte', grade, shots: [], status: 'draft',
        estimated_credits: 0, charged_credits: 0, created_at: now, updated_at: now
      };
      try {
        project = await analyzeFootage(project, supabase);
        // Engine per project from its shots when not fixed: the router reads the shot notes
        let engine = engineFixed;
        let reason = engineFixed ? 'กำหนดเอง' : '';
        if (!engine) {
          const votes = project.shots.map((s) => recommendEngine(s, pref));
          engine = votes.some((v) => v.engine === 'o3') ? 'o3' : 'matte';
          reason = votes.find((v) => v.engine === engine)?.reason || '';
        }
        project = await planProject(project, engine!, grade);
        // A template with a fixed plate: every background layer is already done
        if (template?.background_image_url) {
          for (const s of project.shots) for (const l of s.layers) {
            if (l.type === 'background') { l.output = { image_url: template.background_image_url }; l.status = 'done'; l.version = 1; l.cost_credits = 0; }
            if (l.type === 'fx' && template.fx.length) { l.params = { elements: template.fx }; l.enabled = true; }
          }
          project.estimated_credits = projectCredits(project);
        } else if (template?.fx.length) {
          for (const s of project.shots) for (const l of s.layers) if (l.type === 'fx') { l.params = { elements: template.fx }; l.enabled = true; }
        }
        await saveProject(project, supabase);
        results.push({ id: project.id, name: project.name, shots: project.shots.length, seconds: project.footage.seconds, engine, reason, credits: project.estimated_credits });
      } catch (e: any) {
        results.push({ id: project.id, name: project.name, error: e?.message || String(e) });
      }
    }
    const total = results.reduce((s, r) => s + (r.credits || 0), 0);
    return NextResponse.json({ success: true, projects: results, total_credits: total });
  } catch (e: any) {
    console.error('[VFX batch]', e);
    return NextResponse.json({ success: false, error: e?.message || 'สร้างชุดงานไม่สำเร็จ' }, { status: 500 });
  }
}

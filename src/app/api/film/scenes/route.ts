import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { serviceClient, newId, saveFilm, loadFilm } from '@/lib/film/store';
import { loadProject, saveProject, newId as vfxId, putFile } from '@/lib/vfx/store';
import { analyzeFootage, planProject, startShot, persist, projectCredits, redoMatte } from '@/lib/vfx/pipeline';
import { runConsistencyCheck } from '@/lib/film/qa';
import { effectiveContinuity, inspectContinuity, inspectableShots, diffState, isEmptyState } from '@/lib/film/continuity';
import { resolveEffectiveStyle, requireLockedMaster } from '@/lib/film/resolver';
import { gradeToAnchor, extractFrame } from '@/lib/film/color';
import { primeRates } from '@/lib/providers/rates';
import type { VfxProject } from '@/lib/vfx/types';
import type { FilmShot } from '@/lib/film/types';
import { assertTier } from '@/lib/credits/packages';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Scenes and shots (F1):
 *   add_scene   { name, location_master_id, time_of_day?, weather?, style_override? } — master must be locked
 *   add_shot    { scene_id, footage_url, confirm_credits } — generates through VFX Studio with the
 *               scene's LOCKED location plate as the background (no Flux, no free prompt),
 *               grade 'none' (neutral), effective style snapshot stored on the shot; charged.
 *   sync        { scene_id? } — pull finished VFX outputs into the shots (pre-grade)
 *   set_anchor  { scene_id, shot_id, at_seconds? } — approve a frame as the scene anchor
 *   grade_scene { scene_id } — LUT + anchor match every ready shot, measure ΔE; no generation
 *   override    { scene_id, style_override } — scene-level override (exposure, LUT)
 */
export async function POST(req: NextRequest) {
  try {
    await primeRates();
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    { const g = await guard(req, email); if (g instanceof NextResponse) return g; }
    const supabase = serviceClient();
    const film = await loadFilm(email, body.film_id || '', supabase);
    if (!film) return NextResponse.json({ success: false, error: 'ไม่พบหนัง' }, { status: 404 });
    const now = new Date().toISOString();

    if (body.action === 'add_scene') {
      const master = requireLockedMaster(film, String(body.location_master_id || ''), 'location');
      const act = film.acts.find((a) => a.id === body.act_id) || [...film.acts].sort((a, b) => a.order - b.order)[0];
      const inAct = film.scenes.filter((s) => s.act_id === act.id).length;
      film.scenes.push({ id: newId('scn'), act_id: act.id, order: inAct + 1, name: String(body.name || `ฉาก ${film.scenes.length + 1}`).trim(), location_master_id: master.id, time_of_day: String(body.time_of_day || ''), weather: String(body.weather || ''), style_override: body.style_override || {}, shots: [] });
      await saveFilm(film, supabase);
      return NextResponse.json({ success: true, film });
    }

    const scene = film.scenes.find((s) => s.id === body.scene_id);
    if (!scene && body.action !== 'sync') return NextResponse.json({ success: false, error: 'ไม่พบฉาก' }, { status: 404 });

    switch (body.action) {
      case 'override': {
        scene!.style_override = { ...(scene!.style_override || {}), ...(body.style_override || {}) };
        break;
      }
      case 'add_shot': {
        await assertTier(email, 'ultra', supabase); // Film Mode is a Studio/Production feature
        if (!film.bible.locked_at) return NextResponse.json({ success: false, error: 'ล็อก Style Bible ก่อนสร้างช็อต (กันสไตล์เลื่อนกลางเรื่อง)' }, { status: 409 });
        const master = requireLockedMaster(film, scene!.location_master_id, 'location');
        const style = resolveEffectiveStyle(film, scene!);
        const footageUrl = String(body.footage_url || '');
        if (!footageUrl) return NextResponse.json({ success: false, error: 'ต้องมีฟุตเทจ' }, { status: 400 });
        // Shot chaining (F2): within a scene shots run in order — the previous one must be
        // approved, and its last frame (post-matte, pre-grade) rides along as a secondary
        // reference so the look carries over. Scenes are independent and may run in parallel.
        const prev = [...scene!.shots].sort((a, b) => a.order - b.order).slice(-1)[0];
        let chainFrameUrl: string | undefined;
        if (prev) {
          if (prev.status !== 'approved') {
            return NextResponse.json({ success: false, error: `ช็อต ${prev.order} ของฉากนี้ยังไม่ถูกอนุมัติ — อนุมัติก่อนจึงสร้างช็อตถัดไปได้ (ต่างฉากรันขนานได้)`, chain_blocked: true }, { status: 409 });
          }
          if (prev.pre_grade_url) {
            try {
              const frame = await extractFrame(prev.pre_grade_url, -0.3);
              chainFrameUrl = await putFile(`films/${email}/${film.id}/${scene!.id}_${prev.id}_last.jpg`, frame, 'image/jpeg', supabase);
            } catch (e) { console.warn('[Film chain] last frame unavailable:', (e as any)?.message || e); }
          }
        }
        // Generate through VFX Studio, constrained by the film: plate = locked master, neutral grade
        let project: VfxProject = {
          id: vfxId('vfx'), user_email: email, user_id: film.user_id || body.user_id || '', name: `${film.title} · ${scene!.name} · ช็อต ${scene!.shots.length + 1}`,
          footage_url: footageUrl, footage: { seconds: 0, width: 0, height: 0, fps: 0 }, reference_urls: chainFrameUrl ? [master.sheet_urls[0], chainFrameUrl] : [master.sheet_urls[0]],
          instruction: `${master.name} — ${style.neutral_prompt_suffix}${style.continuity_prompt ? `; continuity: ${style.continuity_prompt}` : ''}`, engine: 'matte', grade: 'none', shots: [], status: 'draft',
          estimated_credits: 0, charged_credits: 0, created_at: now, updated_at: now
        };
        project = await analyzeFootage(project, supabase);
        project = await planProject(project, 'matte', 'none');
        for (const s of project.shots) for (const l of s.layers) {
          if (l.type === 'background') { l.output = { image_url: master.sheet_urls[0] }; l.status = 'done'; l.version = 1; l.cost_credits = 0; l.params = { prompt: `plate: ${master.name} v${master.version}` }; }
        }
        project.estimated_credits = projectCredits(project);
        const credits = project.estimated_credits;
        if (Number(body.confirm_credits) !== credits) {
          await saveProject(project, supabase);
          return NextResponse.json({ success: false, error: `ยืนยันราคาก่อน: ช็อตนี้ ${credits} เครดิต`, credits, project_id: project.id }, { status: 409 });
        }
        const isSuperAdmin = email === 'whootthira@gmail.com';
        if (!isSuperAdmin) {
          const { data: wl } = await supabase.from('whitelist').select('generation_limit').eq('email', email).maybeSingle();
          const cost = Math.round(credits * 10);
          if (!wl || (wl.generation_limit || 0) < cost) return NextResponse.json({ success: false, error: `เครดิตไม่พอ (ต้องการ ${credits})` }, { status: 403 });
          await supabase.from('whitelist').update({ generation_limit: (wl.generation_limit || 0) - cost }).eq('email', email);
        }
        project.charged_credits = credits;
        for (const s of project.shots) await startShot(project, s, supabase);
        await persist(project, supabase);
        const shot: FilmShot = {
          id: newId('fsh'), order: scene!.shots.length + 1, prev_shot_id: prev?.id, chain_frame_url: chainFrameUrl,
          vfx_project_id: project.id, vfx_shot_id: project.shots[0]?.id || '',
          master_versions: [{ master_id: master.id, version: master.version }], effective_style: { ...style, chain_frame_url: chainFrameUrl }, status: 'processing', updated_at: now
        };
        master.used_by.push({ version: master.version, shot_id: shot.id });
        scene!.shots.push(shot);
        break;
      }
      case 'sync': {
        for (const sc of film.scenes.filter((s) => !body.scene_id || s.id === body.scene_id)) {
          for (const sh of sc.shots) {
            if (sh.status !== 'processing') continue;
            const p = await loadProject(email, sh.vfx_project_id, supabase);
            const vs = p?.shots.find((x) => x.id === sh.vfx_shot_id) || p?.shots[0];
            if (!vs) continue;
            if ((vs.status === 'review' || vs.status === 'approved') && vs.output_url) { sh.pre_grade_url = vs.output_url; sh.status = 'ready'; sh.updated_at = now; }
            else if (vs.status === 'failed') { sh.status = 'failed'; sh.error = vs.error; sh.updated_at = now; }
          }
        }
        break;
      }
      case 'approve_shot': {
        // Review gate for chaining: a graded (or at least ready) shot can be approved; approving
        // un-approves nothing else. `value: false` reopens it.
        const sh = scene!.shots.find((x) => x.id === body.shot_id);
        if (!sh) return NextResponse.json({ success: false, error: 'ไม่พบช็อต' }, { status: 404 });
        if (body.value === false) { sh.status = sh.post_grade_url ? 'graded' : 'ready'; break; }
        if (!['ready', 'graded'].includes(sh.status)) return NextResponse.json({ success: false, error: 'อนุมัติได้เฉพาะช็อตที่เสร็จแล้ว' }, { status: 400 });
        sh.status = 'approved';
        sh.updated_at = now;
        // F4: after approval the VLM observes the subjects' end-of-shot state and PROPOSES the
        // continuity update — nothing on the board changes until the user confirms.
        const subjects = effectiveContinuity(film, scene!);
        if (subjects.length && (sh.post_grade_url || sh.pre_grade_url)) {
          const check = await inspectContinuity(sh.post_grade_url || sh.pre_grade_url!, subjects, film.masters);
          if (check) {
            sh.continuity = check;
            for (const p of check.per_subject) {
              if (!p.present || !p.observed) continue;
              const expected = subjects.find((s) => s.subject_master_id === p.subject_master_id)!;
              // propose when the board has nothing yet for this subject, or the shot contradicts it
              if (!isEmptyState(expected.state) && expected.source !== 'none' && !expected.inherited_from_scene_id && p.consistent) continue;
              const diff = diffState(expected.state, p.observed);
              if (!diff.length) continue;
              film.continuity_proposals = film.continuity_proposals.filter((x) => !(x.scene_id === scene!.id && x.subject_master_id === p.subject_master_id));
              film.continuity_proposals.push({ id: newId('cprop'), scene_id: scene!.id, subject_master_id: p.subject_master_id, from_shot_id: sh.id, observed: p.observed, diff, at: now });
            }
          }
        }
        break;
      }
      case 'check_continuity': {
        // VLM continuity check of every finished shot in the scene (or one shot) against the
        // scene's continuity_state; advisory flags on the shot cards, no generation.
        const subjects = effectiveContinuity(film, scene!);
        if (!subjects.length) return NextResponse.json({ success: false, error: 'ฉากนี้ไม่มี subject (ตัวละคร/พร็อพ) ให้ตรวจ — เพิ่ม master ตัวละครหรือพร็อพก่อน' }, { status: 400 });
        const targets = inspectableShots(scene!).filter((s) => !body.shot_id || s.id === body.shot_id);
        const results: any[] = [];
        for (const sh of targets) {
          const check = await inspectContinuity(sh.post_grade_url || sh.pre_grade_url!, subjects, film.masters);
          if (check) { sh.continuity = check; sh.updated_at = now; }
          results.push({ shot_id: sh.id, passed: check?.passed ?? null, issues: check ? check.per_subject.flatMap((p) => p.issues.map((i) => `${subjects.find((s) => s.subject_master_id === p.subject_master_id)?.name}: ${i}`)) : ['ตรวจไม่ได้'] });
        }
        await saveFilm(film, supabase);
        return NextResponse.json({ success: true, film, results, flagged: results.filter((r) => r.passed === false).length, subjects: subjects.map((s) => ({ id: s.subject_master_id, name: s.name, source: s.source, inherited_from_scene_id: s.inherited_from_scene_id })) });
      }
      case 'set_subjects': {
        // which character/prop masters are in this scene (unset = all)
        const ids = Array.isArray(body.subject_master_ids) ? body.subject_master_ids.filter((id: any) => film.masters.some((m) => m.id === id && (m.kind === 'character' || m.kind === 'prop'))) : null;
        scene!.subject_master_ids = ids === null ? undefined : ids;
        break;
      }
      case 'preview_style': {
        // the resolver's snapshot for this scene as the next shot would receive it (no job)
        return NextResponse.json({ success: true, style: resolveEffectiveStyle(film, scene!) });
      }
      case 'set_anchor': {
        const sh = scene!.shots.find((x) => x.id === body.shot_id);
        if (!sh?.pre_grade_url) return NextResponse.json({ success: false, error: 'ช็อตนี้ยังไม่มีผลลัพธ์' }, { status: 400 });
        const at = Number(body.at_seconds) || 0.5;
        const frame = await extractFrame(sh.pre_grade_url, at);
        scene!.anchor_frame_url = await putFile(`films/${email}/${film.id}/${scene!.id}_anchor_${Date.now()}.jpg`, frame, 'image/jpeg', supabase);
        scene!.anchor_from_shot_id = sh.id;
        break;
      }
      case 'grade_scene': {
        if (!scene!.anchor_frame_url) return NextResponse.json({ success: false, error: 'ตั้ง anchor frame ของฉากก่อน (อนุมัติเฟรมจากช็อตแรก)' }, { status: 400 });
        const style = resolveEffectiveStyle(film, scene!);
        const results: any[] = [];
        const masterPlate = film.masters.find((m) => m.id === scene!.location_master_id)?.sheet_urls[0];
        // One grade+QA pass is ~30 s per shot on this host; the function has 300 s. Retries are
        // spent only while there is budget left, so a 5-shot scene with 2 retries each cannot
        // time out — shots past the budget are flagged with the retries they got.
        const started = Date.now();
        const budgetLeft = () => Date.now() - started < 120_000;
        for (const sh of scene!.shots) {
          if (!sh.pre_grade_url || sh.status === 'processing' || sh.status === 'failed') continue;
          try {
            // Grade, then the consistency worker (F3). A shot whose colour still sits past the
            // Bible's ΔE after the match is re-graded harder — up to twice — before it is flagged.
            let retries = 0;
            let g = await gradeToAnchor(sh.pre_grade_url, scene!.anchor_frame_url, { lutUrl: style.lut_url, exposureStops: style.exposure_stops, strength: 1 });
            let strengthUsed = 1;
            while (g.deltaE >= style.delta_e_threshold && retries < 2 && budgetLeft()) {
              retries++;
              const strength = 1 + 0.15 * retries;
              const again = await gradeToAnchor(sh.pre_grade_url, scene!.anchor_frame_url, { lutUrl: style.lut_url, exposureStops: style.exposure_stops, strength });
              // a harder match can overshoot (measured: 0.97 → 1.31) — keep the best attempt
              if (again.deltaE < g.deltaE) { g = again; strengthUsed = strength; }
            }
            sh.post_grade_url = await putFile(`films/${email}/${film.id}/${scene!.id}_${sh.id}_b${film.bible.version}_${Date.now()}.mp4`, g.video, 'video/mp4', supabase);
            sh.delta_e = g.deltaE;
            const qa = await runConsistencyCheck({ videoUrl: sh.post_grade_url, anchorImageUrl: scene!.anchor_frame_url, masterPlateUrl: masterPlate, deltaE: g.deltaE, deltaEThreshold: style.delta_e_threshold, retries });
            sh.qa = qa;
            sh.passed = qa.passed;
            if (sh.status !== 'approved') sh.status = 'graded'; // a re-grade does not reopen an approved shot
            sh.effective_style = { ...sh.effective_style, graded_with: { bible_version: film.bible.version, lut: style.lut_name || null, exposure_stops: style.exposure_stops, strength: strengthUsed, gains: g.gains, anchor: g.anchor, before: g.before, after: g.after } };
            sh.updated_at = now;
            results.push({ shot_id: sh.id, delta_e: g.deltaE, histogram: qa.histogram_score, style: qa.style_distance, passed: qa.passed, retries, lut: g.lutApplied, notes: qa.style_notes });
          } catch (e: any) {
            sh.error = `grade: ${e?.message || e}`;
            results.push({ shot_id: sh.id, error: sh.error });
          }
        }
        await saveFilm(film, supabase);
        const measured = results.filter((r) => typeof r.delta_e === 'number');
        const mean = measured.length ? +(measured.reduce((s, r) => s + r.delta_e, 0) / measured.length).toFixed(2) : null;
        return NextResponse.json({ success: true, film, results, mean_delta_e: mean, threshold: style.delta_e_threshold, flagged: results.filter((r) => r.passed === false).length });
      }
      case 'regen_layer': {
        // "gen ใหม่เฉพาะเลเยอร์" from Scene Review: today the matte (person cut-out) is the only
        // generative layer of a film shot; charged at the matte rate through the VFX project.
        const sh = scene!.shots.find((x) => x.id === body.shot_id);
        if (!sh) return NextResponse.json({ success: false, error: 'ไม่พบช็อต' }, { status: 404 });
        const project = await loadProject(email, sh.vfx_project_id, supabase);
        const vs = project?.shots.find((x) => x.id === sh.vfx_shot_id) || project?.shots[0];
        if (!project || !vs) return NextResponse.json({ success: false, error: 'ไม่พบโปรเจกต์ VFX ของช็อตนี้' }, { status: 404 });
        const matteCost = vs.layers.find((l) => l.type === 'matte')?.cost_credits || 0;
        if (email !== 'whootthira@gmail.com' && matteCost > 0) {
          const { data: wl } = await supabase.from('whitelist').select('generation_limit').eq('email', email).maybeSingle();
          const cost = Math.round(matteCost * 10);
          if (!wl || (wl.generation_limit || 0) < cost) return NextResponse.json({ success: false, error: `เครดิตไม่พอ (ต้องการ ${matteCost})` }, { status: 403 });
          await supabase.from('whitelist').update({ generation_limit: (wl.generation_limit || 0) - cost }).eq('email', email);
          project.charged_credits += matteCost;
        }
        await redoMatte(project, vs, supabase);
        await persist(project, supabase);
        sh.status = 'processing';
        sh.pre_grade_url = undefined; sh.post_grade_url = undefined; sh.delta_e = undefined; sh.passed = undefined; sh.qa = undefined; sh.error = undefined;
        sh.updated_at = now;
        break;
      }
      default:
        return NextResponse.json({ success: false, error: 'ไม่รู้จักคำสั่ง' }, { status: 400 });
    }
    await saveFilm(film, supabase);
    return NextResponse.json({ success: true, film });
  } catch (e: any) {
    console.error('[Film scenes]', e);
    return NextResponse.json({ success: false, error: e?.message || 'ทำรายการไม่สำเร็จ' }, { status: 500 });
  }
}

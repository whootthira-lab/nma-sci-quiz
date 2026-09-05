import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { SupabaseClient } from '@supabase/supabase-js';
import { falSubmit, falStatus, falResult, normalizeOutput, FalSubmitError } from '@/lib/providers/fal';
import { assertRunnable, estimateCost } from '@/lib/providers/registry';
import { compositeBackground, gradeVideo, fetchToFile, probeVideo, FxInput } from './composite';
import { newId, putFile, saveProject } from './store';
import { loadFxLibrary, FxParams } from './fx';
import { watermarkVideo } from './watermark';
import { qaShot } from './qa';
import { requireConsent } from './consent';

export const CHARACTER_ID = 'char-motion-control';

/** The footage a shot's matte/edit should work from: the new actor's clip when a character
 *  layer has produced one, else the original segment. */
function sourceClip(shot: VfxShot): string {
  const ch = shot.layers.find((l) => l.type === 'character');
  return (ch?.enabled && ch.status === 'done' && ch.output.video_url) || shot.clip_url;
}
import type { VfxProject, VfxShot, VfxLayer, VfxLayerType, VfxEngine, VfxGrade } from './types';
import { VFX_PHASE1_LIMITS as LIMITS } from './types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * VFX Studio pipeline (Phase 1).
 *
 *   analyzeFootage   footage → shots (scene cuts, trimmed segments, posters, VLM notes)
 *   planProject      brief + shots → per-shot layers with prompts and a price
 *   startShot        submit the shot's model jobs (matte or O3 edit) as generations rows
 *   onLayerJobDone   called by /api/video-status when such a job lands → store artifact,
 *                    then composite when every input of the shot is in
 *   redoBackground   new prompt → new image → re-composite from the STORED matte (no veed)
 *
 * Model calls go through the provider adapter and the registry only; prices come from the
 * registry's bill-verified rates and are what the user confirmed.
 */

export const MATTE_ID = 'matte-veed-fast';
export const O3_EDIT_ID = 'vedit-o3';
export const BG_IMAGE_ID = 'flux-dev';
export const BG_IMAGE_CREDITS = 3;
export const RUN_FEE_CREDITS = 1;

// ───────────────────────────── ffmpeg helpers ─────────────────────────────

function run(args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegInstaller.path, args, { encoding: 'buffer', maxBuffer: opts.maxBuffer || 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errText = (stderr as unknown as Buffer)?.toString?.() || String(stderr || '');
      // ffmpeg exits non-zero for the null muxer with -f null on some builds; the caller decides
      resolve({ stdout: stdout as unknown as Buffer, stderr: errText + (err && !stdout ? `\n${err.message}` : '') });
    });
  });
}

/** Scene-cut times (seconds) — ffmpeg's `scene` score over a threshold. Exists in 4.1. */
async function sceneCuts(file: string, threshold = 0.4): Promise<number[]> {
  const { stderr } = await run(['-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  const cuts: number[] = [];
  const re = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) cuts.push(parseFloat(m[1]));
  return cuts;
}

async function trimSegment(src: string, start: number, end: number, out: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(src)
      .inputOptions([`-ss ${start.toFixed(3)}`])
      .outputOptions([`-t ${(end - start).toFixed(3)}`, '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-c:a aac', '-ar 44100', '-movflags +faststart'])
      .on('end', () => resolve()).on('error', (e: any) => reject(e)).save(out);
  });
}

async function posterFrame(src: string, at: number, out: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(src).inputOptions([`-ss ${at.toFixed(3)}`]).outputOptions(['-frames:v 1', '-vf scale=480:-2', '-q:v 4'])
      .on('end', () => resolve()).on('error', (e: any) => reject(e)).save(out);
  });
}

// ───────────────────────────── Gemini (advisory) ─────────────────────────────

// gemini-2.0-flash and 1.5-flash were retired (404 "no longer available", 5 ก.ย. 2569);
// the API's own message points at 3.6-flash. Responses may carry thought parts without
// text, so every text part is joined rather than reading parts[0].
async function gemini(parts: any[], model = 'gemini-3.6-flash'): Promise<string> {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) throw new Error('no GEMINI_API_KEY');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.4, maxOutputTokens: 1024 } })
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const j = await res.json();
  return j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
}

function parseJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

async function describeShot(posterPath: string): Promise<VfxShot['analysis'] | undefined> {
  try {
    const img = fs.readFileSync(posterPath).toString('base64');
    const text = await gemini([
      { text: 'You are a VFX supervisor logging a shot. Reply with JSON only: {"summary": "<one sentence, English>", "people": <number of people>, "camera": "<static|handheld|pan|tilt|dolly|unknown>", "lighting": "<key light direction and quality, 5-8 words>"}' },
      { inline_data: { mime_type: 'image/jpeg', data: img } }
    ]);
    const j = parseJson<any>(text);
    if (!j) return undefined;
    return { summary: String(j.summary || ''), people: Number(j.people) || 0, camera: String(j.camera || 'unknown'), lighting: String(j.lighting || '') };
  } catch (e) {
    console.warn('[VFX analyze] VLM skipped:', (e as any)?.message || e);
    return undefined;
  }
}

// ───────────────────────────── 1. analyze ─────────────────────────────

export async function analyzeFootage(project: VfxProject, supabase: SupabaseClient): Promise<VfxProject> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx_an_'));
  try {
    const src = path.join(dir, 'footage.mp4');
    await fetchToFile(project.footage_url, src);
    const info = await probeVideo(src);
    if (!info.seconds) throw new Error('อ่านฟุตเทจไม่ได้ (ไม่พบความยาว)');
    if (info.seconds > LIMITS.footageMaxSeconds) throw new Error(`Phase 1 รับฟุตเทจไม่เกิน ${LIMITS.footageMaxSeconds} วินาที (ไฟล์นี้ ${info.seconds.toFixed(1)} วิ)`);
    project.footage = { seconds: info.seconds, width: info.width, height: info.height, fps: info.fps || 25 };

    // Shot boundaries: scene cuts, then long stretches split at the engine cap
    const cuts = (await sceneCuts(src)).filter((t) => t > LIMITS.shotMinSeconds && t < info.seconds - LIMITS.shotMinSeconds);
    const bounds: number[] = [0];
    for (const c of cuts) if (c - bounds[bounds.length - 1] >= LIMITS.shotMinSeconds) bounds.push(c);
    bounds.push(info.seconds);
    const ranges: [number, number][] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      let s = bounds[i];
      const e = bounds[i + 1];
      while (e - s > LIMITS.shotMaxSeconds) { ranges.push([s, s + LIMITS.shotMaxSeconds]); s += LIMITS.shotMaxSeconds; }
      if (e - s >= LIMITS.shotMinSeconds || ranges.length === 0) ranges.push([s, e]);
      else ranges[ranges.length - 1][1] = e; // fold a tiny tail into the previous shot
    }
    if (ranges.length > LIMITS.maxShots) throw new Error(`ฟุตเทจถูกแบ่งได้ ${ranges.length} ช็อต เกินเพดาน ${LIMITS.maxShots} ช็อตของ Phase 1 — ตัดฟุตเทจให้สั้นลง`);

    const shots: VfxShot[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const [s, e] = ranges[i];
      const seg = path.join(dir, `shot_${i}.mp4`);
      const poster = path.join(dir, `shot_${i}.jpg`);
      await trimSegment(src, s, e, seg);
      await posterFrame(seg, Math.min(0.5, (e - s) / 2), poster);
      const base = `vfx_shots/${project.user_email}/${project.id}/shot_${i + 1}`;
      const clipUrl = await putFile(`${base}.mp4`, fs.readFileSync(seg), 'video/mp4', supabase);
      const thumbUrl = await putFile(`${base}.jpg`, fs.readFileSync(poster), 'image/jpeg', supabase);
      const segInfo = await probeVideo(seg);
      shots.push({
        id: newId('shot'), order: i + 1, start: +s.toFixed(3), end: +e.toFixed(3),
        clip_url: clipUrl, thumb_url: thumbUrl,
        width: segInfo.width || info.width, height: segInfo.height || info.height, fps: segInfo.fps || info.fps || 25,
        analysis: await describeShot(poster),
        layers: [], status: 'draft'
      });
    }
    project.shots = shots;
    project.status = 'draft';
    return project;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────────── 2. plan ─────────────────────────────

function layer(type: VfxLayerType, params: Record<string, any>, cost: number, enabled = true, model_id?: string): VfxLayer {
  return { id: newId('lyr'), type, enabled, params, model_id, cost_credits: cost, version: 0, status: 'pending', output: {}, history: [], updated_at: new Date().toISOString() };
}

export function shotCredits(shot: VfxShot): number {
  return shot.layers.filter((l) => l.enabled).reduce((s, l) => s + l.cost_credits, 0);
}

export function projectCredits(project: VfxProject, shotIds?: string[]): number {
  const shots = shotIds ? project.shots.filter((s) => shotIds.includes(s.id)) : project.shots;
  return shots.reduce((s, sh) => s + shotCredits(sh), 0) + RUN_FEE_CREDITS;
}

/** Per-shot background prompts written from the brief; the model plans, it never runs anything. */
async function writeBackgroundPrompts(project: VfxProject): Promise<string[]> {
  const fallback = project.shots.map(() => project.instruction);
  try {
    const shotNotes = project.shots.map((s, i) => `Shot ${i + 1} (${(s.end - s.start).toFixed(1)}s): ${s.analysis?.summary || 'n/a'}; camera ${s.analysis?.camera || 'unknown'}; light ${s.analysis?.lighting || 'unknown'}`).join('\n');
    const text = await gemini([{
      text: `You are a VFX supervisor writing background-plate prompts for an image model.
The director's brief for the new environment: "${project.instruction}"
${project.reference_urls.length ? 'Reference images of the wanted look were supplied; describe the environment consistently with a real location of that kind.' : ''}
Shots:\n${shotNotes}
For EACH shot write one English prompt (25-45 words) describing ONLY the empty environment — no people — matching that shot's camera height/angle and key-light direction so the person will sit naturally in it. Keep the location identical across shots; vary only the angle. Reply with JSON only: {"prompts": ["...", "..."]} with exactly ${project.shots.length} entries.`
    }]);
    const j = parseJson<{ prompts: string[] }>(text);
    if (j?.prompts?.length === project.shots.length) return j.prompts.map((p) => String(p));
  } catch (e) {
    console.warn('[VFX plan] prompt writer skipped:', (e as any)?.message || e);
  }
  return fallback;
}

export async function planProject(project: VfxProject, engine: VfxEngine, grade: VfxGrade): Promise<VfxProject> {
  project.engine = engine;
  project.grade = grade;
  const prompts = await writeBackgroundPrompts(project);
  const matte = assertRunnable(MATTE_ID);
  const o3 = assertRunnable(O3_EDIT_ID);
  project.shots.forEach((shot, i) => {
    const secs = Math.ceil(shot.end - shot.start);
    const existing = new Map(shot.layers.map((l) => [l.type, l]));
    const keepPrompt = existing.get('background')?.params?.prompt || existing.get('edit')?.params?.prompt;
    const prompt = keepPrompt || prompts[i];
    // A character choice (with its consent) survives re-planning; its job does not re-run if done
    const character = existing.get('character');
    const withCharacter = (layers: VfxLayer[]) => (character ? [character, ...layers] : layers);
    if (engine === 'matte') {
      const fxPrev = existing.get('fx');
      shot.layers = withCharacter([
        existing.get('matte') && existing.get('matte')!.status === 'done' ? existing.get('matte')! : layer('matte', {}, estimateCost(matte.id, secs).creditsShown, true, matte.id),
        layer('background', { prompt }, BG_IMAGE_CREDITS, true, BG_IMAGE_ID),
        // Stock effects (Phase 2): off until the review page picks one; free — ffmpeg only
        fxPrev ? fxPrev : layer('fx', { elements: [] as FxParams[] }, 0, false),
        layer('grade', { preset: grade }, 0, grade !== 'none'),
        layer('composite', {}, 0)
      ]);
    } else {
      shot.layers = withCharacter([
        layer('edit', { prompt }, estimateCost(o3.id, Math.min(15, Math.max(3, secs))).creditsShown, true, o3.id),
        layer('grade', { preset: grade }, 0, grade !== 'none')
      ]);
    }
    shot.status = 'draft';
    shot.output_url = undefined;
  });
  project.estimated_credits = projectCredits(project);
  project.status = 'planned';
  return project;
}

// ───────────────────────────── 3. run ─────────────────────────────

async function generateBackgroundImage(prompt: string, w: number, h: number): Promise<string> {
  const model = assertRunnable(BG_IMAGE_ID);
  const r = w && h ? w / h : 16 / 9;
  const size = r > 1.6 ? 'landscape_16_9' : r > 1.1 ? 'landscape_4_3' : r > 0.9 ? 'square_hd' : r > 0.65 ? 'portrait_4_3' : 'portrait_16_9';
  const { requestId } = await falSubmit(model.endpoint, {
    prompt: `${prompt}. Empty environment with no people, photographic, cinematic lighting, high detail`,
    image_size: size, num_images: 1, enable_safety_checker: true
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r2) => setTimeout(r2, 1500));
    const st = await falStatus(model.endpoint, requestId);
    if (st.status === 'COMPLETED') {
      const res = await falResult(model.endpoint, requestId);
      if (!res.ok) throw new Error(`สร้างภาพฉากหลังไม่สำเร็จ (HTTP ${res.httpStatus})`);
      const { url } = normalizeOutput(res.data);
      if (!url) throw new Error('สร้างภาพฉากหลังไม่สำเร็จ (ไม่มีไฟล์ภาพ)');
      return url;
    }
    if (st.status === 'FAILED') throw new Error('สร้างภาพฉากหลังไม่สำเร็จ');
  }
  throw new Error('สร้างภาพฉากหลังนานเกินกำหนด');
}

function setLayerOutput(l: VfxLayer, output: VfxLayer['output'], params?: Record<string, any>) {
  // Any earlier artifact goes to history — regardless of the transient 'processing' status
  // the caller set a moment ago (that check used to swallow every version; found 5 ก.ย.).
  if (Object.keys(l.output).length) {
    l.history.unshift({ version: l.version, output: l.output, params: l.params, at: l.updated_at });
    l.history = l.history.slice(0, 5);
  }
  l.output = output;
  if (params) l.params = { ...l.params, ...params };
  l.version += 1;
  l.status = 'done';
  l.error = undefined;
  l.updated_at = new Date().toISOString();
}

async function insertLayerJob(supabase: SupabaseClient, project: VfxProject, shot: VfxShot, l: VfxLayer, endpoint: string, modelId: string, requestId: string, storagePath: string, prompt: string) {
  await supabase.from('generations').insert({
    user_id: project.user_id,
    prompt,
    source_image_url: shot.thumb_url || null,
    status: 'processing',
    fal_request_id: requestId,
    metadata: {
      mode: 'vfx-layer',
      vfx_project_id: project.id,
      vfx_shot_id: shot.id,
      vfx_layer_id: l.id,
      vfx_user_email: project.user_email,
      model_endpoint: endpoint,
      model_name: modelId,
      is_no_speech: true, narration_only: false, avatar_mode: false, ambient_pending: false,
      storage_path: storagePath,
      storage_provider: 'supabase',
      api_provider: 'fal',
      duration_estimate: Math.ceil(shot.end - shot.start)
    }
  });
}

/** Submit a shot's model jobs. Background images are made inline (seconds); video jobs queue. */
export async function startShot(project: VfxProject, shot: VfxShot, supabase: SupabaseClient): Promise<void> {
  shot.status = 'processing';
  shot.error = undefined;
  const ts = Date.now();
  try {
    // Character first: the new actor's clip becomes the footage every later layer works from.
    // Runs only with a consent record on the layer (checked when the layer was set, and again here).
    const character = shot.layers.find((l) => l.type === 'character');
    if (character?.enabled && character.status !== 'done') {
      const model = assertRunnable(CHARACTER_ID);
      await requireConsent(project.user_email, character.params.consent_id, character.params.face_url, supabase);
      const { requestId } = await falSubmit(model.endpoint, {
        image_url: character.params.face_url,
        video_url: shot.clip_url,
        character_orientation: 'video',
        keep_original_sound: true,
        prompt: character.params.prompt || 'the person performs exactly the reference motion, natural expression, consistent identity'
      });
      character.status = 'processing';
      character.job_request_id = requestId;
      await insertLayerJob(supabase, project, shot, character, model.endpoint, model.id, requestId, `vfx_shots/${project.user_email}/${project.id}/${shot.id}_${ts}_character.mp4`, `character: shot ${shot.order}`);
      return; // onLayerJobDone continues with the matte/edit once the actor clip lands
    }

    if (project.engine === 'matte') {
      const bg = shot.layers.find((l) => l.type === 'background')!;
      if (bg.status !== 'done') {
        bg.status = 'processing';
        const url = await generateBackgroundImage(bg.params.prompt, shot.width, shot.height);
        setLayerOutput(bg, { image_url: url });
      }
      const matte = shot.layers.find((l) => l.type === 'matte')!;
      if (matte.status !== 'done') {
        const model = assertRunnable(MATTE_ID);
        const { requestId } = await falSubmit(model.endpoint, { video_url: sourceClip(shot), output_codec: 'h264', subject_is_person: true, refine_foreground_edges: true });
        matte.status = 'processing';
        matte.job_request_id = requestId;
        await insertLayerJob(supabase, project, shot, matte, model.endpoint, model.id, requestId, `vfx_shots/${project.user_email}/${project.id}/${shot.id}_${ts}_matte.mp4`, `matte: shot ${shot.order}`);
      } else {
        // Matte already stored: nothing to wait for — composite right away
        await compositeShot(project, shot, supabase);
      }
    } else {
      const edit = shot.layers.find((l) => l.type === 'edit')!;
      const model = assertRunnable(O3_EDIT_ID);
      const refs = project.reference_urls.slice(0, 3);
      const prompt = `Replace the entire background and environment of @Video1 with ${edit.params.prompt}${refs.length ? `, matching the look of ${refs.map((_, i) => `@Image${i + 1}`).join(' and ')}` : ''}. Keep the person, their face, clothing, motion, timing and camera framing exactly as in @Video1. Relight the person naturally to match. No text, no extra people.`;
      const body: Record<string, any> = { video_url: sourceClip(shot), prompt, keep_audio: true };
      if (refs.length) body.image_urls = refs;
      const { requestId } = await falSubmit(model.endpoint, body);
      edit.status = 'processing';
      edit.job_request_id = requestId;
      await insertLayerJob(supabase, project, shot, edit, model.endpoint, model.id, requestId, `vfx_shots/${project.user_email}/${project.id}/${shot.id}_${ts}_edit.mp4`, prompt);
    }
  } catch (e: any) {
    shot.status = 'failed';
    shot.error = e instanceof FalSubmitError ? `Fal: ${e.detail}` : (e?.message || String(e));
    for (const l of shot.layers) if (l.status === 'processing') { l.status = 'failed'; l.error = shot.error; }
  }
}

// ───────────────────────────── 4. finish ─────────────────────────────

/** Provenance on outputs that carry a character edit: visible mark + metadata (Phase 3 guardrail). */
async function finishOutput(project: VfxProject, shot: VfxShot, video: Buffer): Promise<Buffer> {
  const ch = shot.layers.find((l) => l.type === 'character');
  if (!ch?.enabled || ch.status !== 'done') return video;
  try {
    return await watermarkVideo(video, { consentId: ch.params.consent_id, projectId: project.id, shotId: shot.id, modelId: ch.model_id || CHARACTER_ID });
  } catch (e) {
    // A character edit must not ship unmarked
    throw new Error(`ใส่ลายน้ำไม่สำเร็จ: ${(e as any)?.message || e}`);
  }
}

/** VLM check of the latest output — flags for the reviewer, never a block. */
async function runQa(shot: VfxShot): Promise<void> {
  if (!shot.output_url) return;
  const ch = shot.layers.find((l) => l.type === 'character');
  const report = await qaShot(shot.output_url, { identityUrl: ch?.enabled ? ch.params.face_url : undefined });
  if (report) shot.qa = report;
}

/** Matte + background (+grade) → the shot. Reads the stored artifacts; never calls a model. */
export async function compositeShot(project: VfxProject, shot: VfxShot, supabase: SupabaseClient): Promise<void> {
  const matte = shot.layers.find((l) => l.type === 'matte');
  const bg = shot.layers.find((l) => l.type === 'background');
  const fxLayer = shot.layers.find((l) => l.type === 'fx');
  const grade = shot.layers.find((l) => l.type === 'grade');
  const comp = shot.layers.find((l) => l.type === 'composite');
  if (!matte?.output.color_url || !matte.output.alpha_url || !bg?.output.image_url || !comp) return;
  comp.status = 'processing';
  try {
    const colorRes = await fetch(matte.output.color_url);
    if (!colorRes.ok) throw new Error('matte colour clip unreachable');
    const preset = grade?.enabled ? grade.params.preset : 'none';
    // Resolve the chosen stock effects to clip URLs; an element that left the library is skipped
    let fx: FxInput[] = [];
    const chosen: FxParams[] = fxLayer?.enabled ? (fxLayer.params.elements || []) : [];
    if (chosen.length) {
      const lib = await loadFxLibrary(supabase);
      fx = chosen.map((p) => {
        const el = lib.find((e) => e.id === p.fx_id);
        return el ? { url: el.url, opacity: p.opacity, placement: p.placement, blend: p.blend } : null;
      }).filter((x): x is FxInput => !!x);
    }
    let out: Buffer = await compositeBackground(
      Buffer.from(await colorRes.arrayBuffer()), matte.output.alpha_url, bg.output.image_url, sourceClip(shot),
      shot.width, shot.height, preset, fx
    );
    out = await finishOutput(project, shot, out);
    const url = await putFile(`vfx_shots/${project.user_email}/${project.id}/${shot.id}_v${comp.version + 1}_out.mp4`, out, 'video/mp4', supabase);
    setLayerOutput(comp, { video_url: url });
    if (grade) { grade.status = grade.enabled ? 'done' : 'skipped'; grade.updated_at = new Date().toISOString(); }
    if (fxLayer) { fxLayer.status = fx.length ? 'done' : 'skipped'; fxLayer.updated_at = new Date().toISOString(); }
    shot.output_url = url;
    shot.status = 'review';
    shot.error = undefined;
    await runQa(shot);
  } catch (e: any) {
    comp.status = 'failed';
    comp.error = e?.message || String(e);
    shot.status = 'failed';
    shot.error = `ประกอบภาพไม่สำเร็จ: ${comp.error}`;
  }
}

/**
 * A layer job's Fal result landed. `urls` is the raw model output (matte: colour + alpha
 * clips; edit: the re-rendered shot). Stores the artifact and finishes the shot if it can.
 */
export async function onLayerJobDone(
  project: VfxProject, shotId: string, layerId: string, urls: { video?: string; color?: string; alpha?: string }, supabase: SupabaseClient
): Promise<void> {
  const shot = project.shots.find((s) => s.id === shotId);
  const l = shot?.layers.find((x) => x.id === layerId);
  if (!shot || !l) return;
  if (l.type === 'character') {
    if (!urls.video) { l.status = 'failed'; l.error = 'ไม่มีคลิปนักแสดงใหม่กลับมา'; shot.status = 'failed'; shot.error = l.error; return; }
    // Keep our own copy (Fal URLs expire), then carry on with the rest of the shot from it
    const url = await putFile(`vfx_shots/${project.user_email}/${project.id}/${shot.id}_v${l.version + 1}_character.mp4`, Buffer.from(await (await fetch(urls.video)).arrayBuffer()), 'video/mp4', supabase);
    setLayerOutput(l, { video_url: url });
    // The matte (or edit) must be redone on the new actor's clip
    for (const x of shot.layers) if (x.type === 'matte' || x.type === 'edit') { x.status = 'pending'; x.job_request_id = undefined; }
    await startShot(project, shot, supabase);
    return;
  }
  if (l.type === 'matte') {
    if (!urls.color || !urls.alpha) { l.status = 'failed'; l.error = 'ผลตัดคนไม่ครบ (ต้องมีทั้ง color และ alpha)'; shot.status = 'failed'; shot.error = l.error; return; }
    // Copy the two clips into our storage: Fal's URLs are not permanent, and a later
    // background redo must still find them (spec: never re-run the matte).
    const base = `vfx_shots/${project.user_email}/${project.id}/${shot.id}_v${l.version + 1}`;
    const colorUrl = await putFile(`${base}_color.mp4`, Buffer.from(await (await fetch(urls.color)).arrayBuffer()), 'video/mp4', supabase);
    const alphaUrl = await putFile(`${base}_alpha.mp4`, Buffer.from(await (await fetch(urls.alpha)).arrayBuffer()), 'video/mp4', supabase);
    setLayerOutput(l, { color_url: colorUrl, alpha_url: alphaUrl });
    await compositeShot(project, shot, supabase);
  } else if (l.type === 'edit') {
    if (!urls.video) { l.status = 'failed'; l.error = 'ไม่มีไฟล์วิดีโอกลับมา'; shot.status = 'failed'; shot.error = l.error; return; }
    const grade = shot.layers.find((x) => x.type === 'grade');
    let buf: Buffer = Buffer.from(await (await fetch(urls.video)).arrayBuffer());
    if (grade?.enabled && grade.params.preset && grade.params.preset !== 'none' && grade.params.preset !== 'match') {
      buf = await gradeVideo(buf, grade.params.preset);
    }
    buf = await finishOutput(project, shot, buf);
    const url = await putFile(`vfx_shots/${project.user_email}/${project.id}/${shot.id}_v${l.version + 1}_out.mp4`, buf, 'video/mp4', supabase);
    setLayerOutput(l, { video_url: url });
    if (grade) { grade.status = grade.enabled ? 'done' : 'skipped'; }
    shot.output_url = url;
    shot.status = 'review';
    await runQa(shot);
  }
}

export function onLayerJobFailed(project: VfxProject, shotId: string, layerId: string, error: string) {
  const shot = project.shots.find((s) => s.id === shotId);
  const l = shot?.layers.find((x) => x.id === layerId);
  if (!shot || !l) return;
  l.status = 'failed';
  l.error = error;
  shot.status = 'failed';
  shot.error = error;
}

/** New background from a new prompt, re-composited from the stored matte. No veed re-run. */
export async function redoBackground(project: VfxProject, shot: VfxShot, prompt: string, supabase: SupabaseClient): Promise<void> {
  if (project.engine !== 'matte') throw new Error('การ gen ใหม่เฉพาะฉากหลังใช้ได้กับเครื่องยนต์ตัดคน+วางฉาก');
  const bg = shot.layers.find((l) => l.type === 'background')!;
  const matte = shot.layers.find((l) => l.type === 'matte');
  bg.status = 'processing';
  shot.status = 'processing';
  try {
    const url = await generateBackgroundImage(prompt, shot.width, shot.height);
    setLayerOutput(bg, { image_url: url }, { prompt });
    if (matte?.status === 'done') await compositeShot(project, shot, supabase);
    else shot.status = 'processing'; // the matte is still in flight; onLayerJobDone will composite
  } catch (e: any) {
    bg.status = 'failed';
    bg.error = e?.message || String(e);
    shot.status = 'failed';
    shot.error = bg.error;
  }
}

/** Re-run the whole shot with a new prompt (O3 engine), or re-composite with a new grade. */
export async function regradeShot(project: VfxProject, shot: VfxShot, preset: VfxGrade, supabase: SupabaseClient): Promise<void> {
  const grade = shot.layers.find((l) => l.type === 'grade');
  if (!grade) return;
  grade.params.preset = preset;
  grade.enabled = preset !== 'none';
  if (project.engine === 'matte') {
    await compositeShot(project, shot, supabase);
  } else {
    const edit = shot.layers.find((l) => l.type === 'edit');
    const raw = edit?.history[0]?.output.video_url || edit?.output.video_url; // graded already; acceptable for a preset swap
    if (!raw) return;
    let buf = Buffer.from(await (await fetch(raw)).arrayBuffer());
    if (preset !== 'none' && preset !== 'match') buf = await gradeVideo(buf, preset);
    const url = await putFile(`vfx_shots/${project.user_email}/${project.id}/${shot.id}_g${Date.now()}_out.mp4`, buf, 'video/mp4', supabase);
    shot.output_url = url;
    shot.status = 'review';
  }
}

/** Choose the stock effects for a shot (free) and re-composite from the stored artifacts. */
export async function setShotFx(project: VfxProject, shot: VfxShot, elements: FxParams[], supabase: SupabaseClient): Promise<void> {
  if (project.engine !== 'matte') throw new Error('เลเยอร์ FX ใช้ได้กับเครื่องยนต์ตัดคน+วางฉาก (O3 edit เรนเดอร์ทั้งเฟรมในตัว)');
  let fxLayer = shot.layers.find((l) => l.type === 'fx');
  if (!fxLayer) {
    fxLayer = layer('fx', { elements: [] }, 0, false);
    const gradeIdx = shot.layers.findIndex((l) => l.type === 'grade');
    shot.layers.splice(gradeIdx < 0 ? shot.layers.length : gradeIdx, 0, fxLayer);
  }
  const clean = elements.slice(0, 3).map((e) => ({
    fx_id: String(e.fx_id),
    opacity: Math.min(1, Math.max(0.05, Number(e.opacity) || 0.7)),
    placement: e.placement === 'behind' ? 'behind' as const : 'front' as const,
    blend: (['screen', 'lighten', 'addition'] as const).includes(e.blend) ? e.blend : 'screen' as const,
    scale: 1
  }));
  fxLayer.history.unshift({ version: fxLayer.version, output: fxLayer.output, params: fxLayer.params, at: fxLayer.updated_at });
  fxLayer.history = fxLayer.history.slice(0, 5);
  fxLayer.params = { elements: clean };
  fxLayer.enabled = clean.length > 0;
  fxLayer.version += 1;
  fxLayer.updated_at = new Date().toISOString();
  await compositeShot(project, shot, supabase);
}

/** Put a layer back to an earlier version and rebuild what depends on it. */
export async function rollbackLayer(project: VfxProject, shot: VfxShot, layerId: string, toVersion: number, supabase: SupabaseClient): Promise<void> {
  const l = shot.layers.find((x) => x.id === layerId);
  if (!l) throw new Error('ไม่พบเลเยอร์');
  const entry = l.history.find((h) => h.version === toVersion);
  if (!entry) throw new Error('ไม่พบเวอร์ชันนั้น');
  // The current state becomes history too, so a rollback can itself be undone
  l.history = [{ version: l.version, output: l.output, params: l.params, at: l.updated_at }, ...l.history.filter((h) => h.version !== toVersion)].slice(0, 5);
  l.output = entry.output;
  l.params = entry.params;
  l.version += 1;
  l.status = Object.keys(entry.output).length || l.type === 'fx' || l.type === 'grade' ? 'done' : 'pending';
  l.updated_at = new Date().toISOString();
  if (l.type === 'fx') l.enabled = (entry.params.elements || []).length > 0;
  if (l.type === 'grade') l.enabled = entry.params.preset && entry.params.preset !== 'none';
  if (l.type === 'composite' || l.type === 'edit') {
    shot.output_url = entry.output.video_url;
    shot.status = shot.output_url ? 'review' : 'draft';
    return;
  }
  if (project.engine === 'matte') await compositeShot(project, shot, supabase);
}

/**
 * Choose (or clear) the character for a shot. Requires a consent record that covers the face.
 * Setting it invalidates the matte/edit (they must be redone on the new actor's clip) and
 * queues the shot; the caller charges the character rate plus the matte/edit redo.
 */
export async function setShotCharacter(
  project: VfxProject, shot: VfxShot, choice: { face_url: string; consent_id: string; prompt?: string } | null, supabase: SupabaseClient
): Promise<void> {
  let ch = shot.layers.find((l) => l.type === 'character');
  if (!choice) {
    if (ch) { ch.enabled = false; ch.status = 'skipped'; }
    // back to the original footage: matte/edit must be redone on it
    for (const x of shot.layers) if (x.type === 'matte' || x.type === 'edit') { x.status = 'pending'; x.job_request_id = undefined; }
    return;
  }
  await requireConsent(project.user_email, choice.consent_id, choice.face_url, supabase);
  const model = assertRunnable(CHARACTER_ID);
  const secs = Math.ceil(shot.end - shot.start);
  const cost = estimateCost(model.id, secs).creditsShown;
  if (!ch) {
    ch = layer('character', {}, cost, true, model.id);
    shot.layers.unshift(ch);
  }
  if (Object.keys(ch.output).length) {
    ch.history.unshift({ version: ch.version, output: ch.output, params: ch.params, at: ch.updated_at });
    ch.history = ch.history.slice(0, 5);
  }
  ch.enabled = true;
  ch.params = { face_url: choice.face_url, consent_id: choice.consent_id, prompt: choice.prompt || '' };
  ch.cost_credits = cost;
  ch.model_id = model.id;
  ch.status = 'pending';
  ch.output = {};
  ch.job_request_id = undefined;
  ch.updated_at = new Date().toISOString();
  for (const x of shot.layers) if (x.type === 'matte' || x.type === 'edit') { x.status = 'pending'; x.job_request_id = undefined; }
}

/** Run the matte again (e.g. after a bad edge) and re-composite. Charged at the matte rate. */
export async function redoMatte(project: VfxProject, shot: VfxShot, supabase: SupabaseClient): Promise<void> {
  const matte = shot.layers.find((l) => l.type === 'matte');
  if (!matte) throw new Error('ช็อตนี้ไม่มีเลเยอร์ตัดคน');
  matte.status = 'pending';
  matte.job_request_id = undefined;
  await startShot(project, shot, supabase);
}

export async function persist(project: VfxProject, supabase: SupabaseClient) {
  const allReview = project.shots.length > 0 && project.shots.every((s) => s.status === 'review' || s.status === 'approved');
  const anyProcessing = project.shots.some((s) => s.status === 'processing');
  if (project.status !== 'exported') project.status = anyProcessing ? 'processing' : allReview ? 'review' : project.status === 'draft' ? 'draft' : 'planned';
  await saveProject(project, supabase);
}

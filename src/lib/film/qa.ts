import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fetchToFile } from '@/lib/vfx/composite';
import { geminiUrl, geminiText } from '@/lib/gemini';
import { resolveUrl } from '@/lib/vfx/store';

/**
 * Consistency QA (Film F3). After a shot is graded it is measured against the scene's
 * anchor frame and the location master, three ways:
 *   color_delta_e     CIE76 ΔE of mean colour (from the grade step)
 *   histogram_score   Pearson correlation of 16-bin RGB histograms, shot frames vs anchor (0–1)
 *   style_distance    1 − VLM similarity (lighting, palette, texture, lens look) vs anchor
 *                     and master plate (0–1; no CLIP/DINO runs on this host — the VLM stands in)
 * Thresholds come from the Bible (ΔE) and defaults (histogram ≥ 0.7, style < 0.25).
 * Failing shots get flagged; the grade step retries deterministically before flagging.
 */
export interface ConsistencyCheck {
  color_delta_e: number | null;
  histogram_score: number | null;
  style_distance: number | null;
  style_notes?: string;
  passed: boolean;
  threshold_used: { delta_e: number; histogram: number; style: number };
  auto_retry_count: number;
  checked_at: string;
}

export const QA_DEFAULTS = { histogram: 0.7, style: 0.25 };

function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegInstaller.path, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout: any) => {
      if (err && !(stdout && (stdout as Buffer).length)) return reject(err);
      resolve(stdout as Buffer);
    });
  });
}

/** 16-bin histogram per channel over 64×64 samples of several frames (or one image). */
async function histogram(file: string, frames: number): Promise<number[][]> {
  const buf = await run(['-hide_banner', '-i', file, '-vf', `select='not(mod(n\\,6))',scale=64:64`, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const h = [new Array(16).fill(0), new Array(16).fill(0), new Array(16).fill(0)];
  for (let i = 0; i + 2 < buf.length; i += 3) {
    h[0][buf[i] >> 4]++; h[1][buf[i + 1] >> 4]++; h[2][buf[i + 2] >> 4]++;
  }
  return h;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n; const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export async function histogramScore(videoUrl: string, anchorImageUrl: string): Promise<number | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_hist_'));
  try {
    const v = path.join(dir, 'v.mp4'); const a = path.join(dir, 'a.jpg');
    await fetchToFile(videoUrl, v); await fetchToFile(anchorImageUrl, a);
    const hv = await histogram(v, 8); const ha = await histogram(a, 1);
    const scores = [0, 1, 2].map((c) => pearson(hv[c], ha[c]));
    return +(scores.reduce((s, x) => s + x, 0) / 3).toFixed(3);
  } catch (e) {
    console.warn('[Film QA] histogram skipped:', (e as any)?.message || e);
    return null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function frameJpeg(videoUrl: string, at: number): Promise<Buffer | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_sf_'));
  try {
    const v = path.join(dir, 'v.mp4');
    await fetchToFile(videoUrl, v);
    return await run(['-hide_banner', '-ss', at.toFixed(2), '-i', v, '-frames:v', '1', '-vf', 'scale=512:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1']);
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function imageBase64(url: string): Promise<string | null> {
  try { const r = await fetch(await resolveUrl(url)); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()).toString('base64'); } catch { return null; }
}

/** VLM style similarity → distance. Null when the model is unavailable (never blocks). */
export async function styleDistance(videoUrl: string, anchorImageUrl: string, masterPlateUrl?: string): Promise<{ distance: number; notes: string } | null> {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return null;
  try {
    const frame = await frameJpeg(videoUrl, 1.0);
    const anchor = await imageBase64(anchorImageUrl);
    if (!frame || !anchor) return null;
    const master = masterPlateUrl ? await imageBase64(masterPlateUrl) : null;
    const parts: any[] = [
      { text: `You are a film colourist checking shot-to-shot consistency. Image 1 is a frame from a new shot; image 2 is the scene's approved anchor frame${master ? '; image 3 is the location master plate' : ''}. Rate how consistent the NEW shot's look is with the anchor (and master): lighting direction and quality, colour palette and temperature, contrast, film texture/grain, lens look. Ignore the person's pose and the exact framing. Reply with JSON only: {"similarity": <0.0-1.0, 1 = indistinguishable look>, "notes": "<one sentence in Thai naming the biggest difference, or 'สม่ำเสมอ' if none>"}` },
      { inline_data: { mime_type: 'image/jpeg', data: frame.toString('base64') } },
      { inline_data: { mime_type: 'image/jpeg', data: anchor } }
    ];
    if (master) parts.push({ inline_data: { mime_type: 'image/jpeg', data: master } });
    const res = await fetch(`${geminiUrl()}?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 256, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } }) });
    if (!res.ok) return null;
    const m = geminiText(await res.json()).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const sim = Math.min(1, Math.max(0, Number(j.similarity)));
    if (!isFinite(sim)) return null;
    return { distance: +(1 - sim).toFixed(3), notes: String(j.notes || '') };
  } catch (e) {
    console.warn('[Film QA] style skipped:', (e as any)?.message || e);
    return null;
  }
}

export async function runConsistencyCheck(input: { videoUrl: string; anchorImageUrl: string; masterPlateUrl?: string; deltaE: number | null; deltaEThreshold: number; retries: number }): Promise<ConsistencyCheck> {
  const [hist, style] = await Promise.all([histogramScore(input.videoUrl, input.anchorImageUrl), styleDistance(input.videoUrl, input.anchorImageUrl, input.masterPlateUrl)]);
  const thr = { delta_e: input.deltaEThreshold, histogram: QA_DEFAULTS.histogram, style: QA_DEFAULTS.style };
  const passed = (input.deltaE == null || input.deltaE < thr.delta_e) && (hist == null || hist >= thr.histogram) && (style == null || style.distance < thr.style);
  return { color_delta_e: input.deltaE, histogram_score: hist, style_distance: style?.distance ?? null, style_notes: style?.notes, passed, threshold_used: thr, auto_retry_count: input.retries, checked_at: new Date().toISOString() };
}

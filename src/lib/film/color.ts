import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fetchToFile, probeVideo } from '@/lib/vfx/composite';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Film Mode colour pipeline — deterministic, generation-free.
 *   1. LUT from the Style Bible (.cube via lut3d — present in the deployed ffmpeg 4.1)
 *   2. match to the scene's anchor frame: per-channel gains that move the shot's mean
 *      colour onto the anchor's (this is the anchor-frame colour match from merge-dialogue,
 *      at full strength and with a luma term, because here every shot shares one plate)
 *   3. measure what is left: CIE76 ΔE between the graded shot's mean colour and the
 *      anchor's, in Lab. The Bible's threshold (default 6) decides pass/flag.
 * Pre-grade and post-grade files stay separate, so a new LUT re-runs only this.
 */

export type Rgb = [number, number, number];

function meanRgb(file: string, extra = ''): Promise<Rgb | null> {
  return new Promise((resolve) => {
    execFile(ffmpegInstaller.path, ['-i', file, '-vf', `${extra ? extra + ',' : ''}select='not(mod(n\\,8))',scale=1:1`, '-frames:v', '40', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 }, (err: any, stdout: any) => {
        const b = stdout as Buffer;
        if (err || !b || b.length < 3) return resolve(null);
        const n = Math.floor(b.length / 3);
        let r = 0, g = 0, bl = 0;
        for (let k = 0; k < n; k++) { r += b[k * 3]; g += b[k * 3 + 1]; bl += b[k * 3 + 2]; }
        resolve([r / n, g / n, bl / n]);
      });
  });
}

// sRGB → CIE Lab (D65), for ΔE76
function toLab([r8, g8, b8]: Rgb): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toLab(a); const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** Save one frame of a clip as JPEG (the anchor candidate). */
export async function extractFrame(videoUrl: string, atSeconds: number): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_fr_'));
  try {
    const v = path.join(dir, 'v.mp4'); const out = path.join(dir, 'f.jpg');
    await fetchToFile(videoUrl, v);
    await new Promise<void>((resolve, reject) => {
      // negative = from the end (last frame for shot chaining), same trick as /api/extract-frame
      const seek = atSeconds < 0 ? `-sseof ${atSeconds.toFixed(2)}` : `-ss ${atSeconds.toFixed(2)}`;
      ffmpeg(v).inputOptions([seek]).outputOptions(['-frames:v 1', '-q:v 2']).on('end', () => resolve()).on('error', (e: any) => reject(e)).save(out);
    });
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export interface GradeResult { video: Buffer; deltaE: number; before: Rgb; after: Rgb; anchor: Rgb; gains: Rgb; lutApplied: boolean }

/**
 * Grade a pre-grade clip: LUT (optional) → anchor match → measure ΔE.
 * `exposureStops` (scene/act override) scales luma before the match.
 */
export async function gradeToAnchor(preGradeUrl: string, anchorImageUrl: string, opts: { lutUrl?: string; exposureStops?: number; strength?: number }): Promise<GradeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_gr_'));
  try {
    const src = path.join(dir, 'src.mp4'); const anchor = path.join(dir, 'anchor.jpg'); const lutted = path.join(dir, 'lut.mp4'); const out = path.join(dir, 'out.mp4');
    await fetchToFile(preGradeUrl, src);
    await fetchToFile(anchorImageUrl, anchor);
    let lutPath = '';
    if (opts.lutUrl) { lutPath = path.join(dir, 'bible.cube'); await fetchToFile(opts.lutUrl, lutPath); }
    const info = await probeVideo(src);

    // 1. LUT pass (its own encode so the measurement below sees the LUT's colours)
    let measured = src;
    if (lutPath) {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(src).outputOptions([`-vf lut3d=${lutPath.replace(/([\\:'])/g, '\\$1')}`, '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-c:a copy'])
          .on('end', () => resolve()).on('error', (e: any) => reject(new Error(`lut3d: ${e?.message || e}`))).save(lutted);
      });
      measured = lutted;
    }

    // 2. anchor match on mean colour (with an exposure term first)
    const stops = opts.exposureStops || 0;
    const expo = stops ? Math.pow(2, stops) : 1;
    const before = (await meanRgb(measured)) || [128, 128, 128];
    const anchorMean = (await meanRgb(anchor)) || before;
    const strength = opts.strength ?? 1.0;
    const gains = [0, 1, 2].map((i) => {
      const src = Math.max(4, before[i] * expo);
      const raw = anchorMean[i] / src;
      const eased = 1 + (raw - 1) * strength;
      return Math.min(1.35, Math.max(0.7, eased)) * expo;
    }) as Rgb;
    const chain = `colorchannelmixer=rr=${gains[0].toFixed(4)}:gg=${gains[1].toFixed(4)}:bb=${gains[2].toFixed(4)}`;
    await new Promise<void>((resolve, reject) => {
      ffmpeg(measured).outputOptions([`-vf ${chain}`, `-r ${info.fps || 25}`, '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-c:a copy', '-movflags +faststart'])
        .on('end', () => resolve()).on('error', (e: any) => reject(new Error(`match: ${e?.message || e}`))).save(out);
    });

    // 3. what is left
    const after = (await meanRgb(out)) || before;
    return { video: fs.readFileSync(out), deltaE: +deltaE(after, anchorMean).toFixed(2), before, after, anchor: anchorMean, gains, lutApplied: !!lutPath };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** ΔE of a finished clip against an anchor image (no re-encode) — for reports. */
export async function measureDeltaE(videoUrl: string, anchorImageUrl: string): Promise<number | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_de_'));
  try {
    const v = path.join(dir, 'v.mp4'); const a = path.join(dir, 'a.jpg');
    await fetchToFile(videoUrl, v); await fetchToFile(anchorImageUrl, a);
    const m = await meanRgb(v); const am = await meanRgb(a);
    return m && am ? +deltaE(m, am).toFixed(2) : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

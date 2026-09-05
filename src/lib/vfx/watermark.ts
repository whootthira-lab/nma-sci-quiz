import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { probeVideo } from './composite';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Provenance marks for outputs that carry a character edit (Phase 3 guardrail):
 *   1. a visible mark — the studio logo, semi-transparent, bottom-right, sized to the frame
 *   2. container metadata naming the edit and the consent record
 * Overlaying a PNG needs nothing the 2018 deployed ffmpeg lacks (drawtext would need a font
 * build we cannot rely on). Full C2PA signing stays a later phase, as the spec says.
 */
export interface WatermarkInfo {
  consentId: string;
  projectId: string;
  shotId: string;
  modelId: string;
}

const LOGO = path.join(process.cwd(), 'public', 'logo-inowok.png');

export async function watermarkVideo(input: Buffer, info: WatermarkInfo): Promise<Buffer> {
  const dir = os.tmpdir();
  const inPath = path.join(dir, `wm_in_${Date.now()}.mp4`);
  const outPath = path.join(dir, `wm_out_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(inPath, input);
    const v = await probeVideo(inPath);
    const W = v.width || 1280;
    const logoW = Math.max(64, Math.round(W * 0.11));
    const margin = Math.round(W * 0.02);
    const hasLogo = fs.existsSync(LOGO);
    const comment = `AI character edit · consent ${info.consentId} · project ${info.projectId} shot ${info.shotId} · model ${info.modelId} · KRUTH VFX Studio`;
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg().input(inPath);
      const out = ['-map 0:a?', '-c:a copy', '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-movflags +faststart',
        `-metadata comment=${comment}`, '-metadata title=KRUTH VFX (AI character edit)'];
      if (hasLogo) {
        cmd.input(LOGO);
        cmd.complexFilter(`[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.55[wm];[0:v][wm]overlay=W-w-${margin}:H-h-${margin}:format=yuv420[out]`);
        out.unshift('-map [out]');
      } else {
        out.unshift('-map 0:v');
      }
      cmd.outputOptions(out).on('end', () => resolve()).on('error', (e: any) => reject(e)).save(outPath);
    });
    return fs.readFileSync(outPath);
  } finally {
    for (const p of [inPath, outPath]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}

import { NextRequest, NextResponse } from 'next/server';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Temporary diagnosis: does the DEPLOYED ffmpeg pad audio the way the local one does?
 * Generates a 2s tone, runs the exact padSpeechWithSilence filter chain, and reports
 * durations — because the padding failure on production was only ever visible as a
 * console.warn nobody can read. Remove once the answer is settled.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('email') !== 'whootthira@gmail.com') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const out: Record<string, any> = {};
  const dir = os.tmpdir();
  const tone = path.join(dir, `diag_tone_${Date.now()}.mp3`);
  const padded = path.join(dir, `diag_pad_${Date.now()}.mp3`);
  try {
    out.version = execFileSync(ffmpegInstaller.path, ['-version']).toString().split('\n')[0];
  } catch (e: any) {
    out.version_error = e?.message?.slice(0, 200);
  }
  try {
    execFileSync(ffmpegInstaller.path, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', tone], { stdio: 'pipe' });
    out.tone = 'ok';
    await new Promise<void>((resolve, reject) => {
      ffmpeg(tone)
        .audioFilters(['aformat=channel_layouts=mono', 'adelay=1000', 'apad=pad_dur=1'])
        .outputOptions(['-c:a libmp3lame', '-b:a 128k', '-ar 44100'])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(padded);
    });
    const banner = (() => { try { execFileSync(ffmpegInstaller.path, ['-i', padded], { stdio: 'pipe' }); return ''; } catch (e: any) { return e?.stderr?.toString() || ''; } })();
    out.padded_duration = (banner.match(/Duration: ([\d:.]+)/) || [])[1] || 'unknown';
    out.pad = 'ok (คาดหวัง ~4 วิ จากโทน 2 วิ)';
  } catch (e: any) {
    out.pad_error = (e?.message || String(e)).slice(0, 300);
  } finally {
    for (const p of [tone, padded]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
  return NextResponse.json(out);
}

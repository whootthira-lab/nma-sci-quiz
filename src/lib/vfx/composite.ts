import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import path from "path";
import os from "os";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * ffmpeg pieces of the VFX pipeline, shared by /api/video-status (layer jobs finishing) and
 * the VFX Studio routes (re-composites after a background redo). Everything here is limited
 * to what the deployed 2018 ffmpeg build has — see the notes on each function.
 */

/** Colour grades as filter chains the 2018 deployed ffmpeg has (eq, colorbalance). */
export function gradeChain(grade: string): string {
  switch (grade) {
    case 'warm': return 'colorbalance=rs=0.10:gs=0.03:bs=-0.10:rm=0.06:bm=-0.06,eq=saturation=1.05';
    case 'cool': return 'colorbalance=rs=-0.06:bs=0.10:rm=-0.04:bm=0.06';
    case 'cinematic': return 'eq=contrast=1.08:saturation=0.88,colorbalance=rs=-0.08:gs=-0.02:bs=0.10:bm=0.02:rh=0.10:gh=0.03:bh=-0.10';
    default: return '';
  }
}

export async function fetchToFile(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์ไม่สำเร็จ (${res.status}): ${url.slice(0, 80)}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Frame size and length of a clip, read from ffmpeg's own banner (no ffprobe is deployed). */
export function probeVideo(file: string): Promise<{ width: number; height: number; seconds: number; fps: number }> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = require('child_process').spawn(ffmpegInstaller.path, ['-hide_banner', '-i', file]);
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', () => {
      const dim = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      const dur = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const fps = stderr.match(/Video:.*?([\d.]+) fps/);
      resolve({
        width: dim ? +dim[1] : 0,
        height: dim ? +dim[2] : 0,
        seconds: dur ? (+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) : 0,
        fps: fps ? +fps[1] : 0
      });
    });
  });
}

/**
 * VFX background replacement, matte engine. veed's h264 mode hands back the person as an
 * RGB clip plus a separate alpha clip; the old ffmpeg cannot decode VP9 alpha but it can
 * `alphamerge` two ordinary streams, so: grade the person, merge the alpha in, size the
 * background image to the footage, overlay, and put the footage's own audio back.
 * The composite IS the product here, so a failure is reported rather than shipped around.
 */
export async function compositeBackground(
  rgb: Buffer, alphaUrl: string, backgroundUrl: string, footageUrl: string,
  width: number, height: number, grade: string
): Promise<any> {
  const dir = os.tmpdir();
  const tag = `vfx_${Date.now()}`;
  const rgbPath = path.join(dir, `${tag}_rgb.mp4`);
  const alphaPath = path.join(dir, `${tag}_alpha.mp4`);
  const bgPath = path.join(dir, `${tag}_bg.img`);
  const srcPath = path.join(dir, `${tag}_src.mp4`);
  const outPath = path.join(dir, `${tag}_out.mp4`);
  try {
    fs.writeFileSync(rgbPath, rgb);
    await fetchToFile(alphaUrl, alphaPath);
    await fetchToFile(backgroundUrl, bgPath);
    let haveAudio = false;
    if (footageUrl) {
      try { await fetchToFile(footageUrl, srcPath); haveAudio = true; } catch (e) { console.warn('[VFX] footage audio unavailable:', e); }
    }

    // The clips' own frame size is the truth; the client's measurement is only a fallback
    // (a wrong number here crops the person, as the first production run showed).
    const rgbInfo = await probeVideo(rgbPath);
    const alphaInfo = await probeVideo(alphaPath);
    const srcInfo = haveAudio ? await probeVideo(srcPath) : { width: 0, height: 0, seconds: 0, fps: 0 };
    const W = alphaInfo.width || rgbInfo.width || width;
    const H = alphaInfo.height || rgbInfo.height || height;
    // veed's colour clip came back SHORTER than its alpha clip (6.36 s vs 7.20 s on the first
    // production run) and is only the footage re-encoded anyway. When the original footage
    // has the alpha's frame size, it is the colour source: full length, first-generation
    // pixels, and its own audio. The colour clip is the fallback.
    const useSource = haveAudio && srcInfo.width === W && srcInfo.height === H;
    const colorIn = useSource ? '[3:v]' : '[1:v]';
    console.log(`[VFX composite] color ${rgbInfo.width}x${rgbInfo.height} ${rgbInfo.seconds}s · alpha ${alphaInfo.seconds}s · footage ${srcInfo.width}x${srcInfo.height} ${srcInfo.seconds}s · canvas ${W}x${H} · colour from ${useSource ? 'footage' : 'veed'}`);

    const g = gradeChain(grade);
    const fgChain = `${colorIn}${g ? g + ',' : ''}format=rgba[fg];[2:v]format=gray[a];[fg][a]alphamerge[fga]`;
    // Background covers the person's frame (scaled up to cover, centre-cropped), else
    // stretched to the foreground's own size when even the clip could not be measured.
    const bgChain = W && H
      ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg];[bg][fga]overlay=0:0:shortest=1:format=yuv420[out]`
      : `[0:v][fga]scale2ref[bg][fga2];[bg][fga2]overlay=0:0:shortest=1:format=yuv420[out]`;

    // The looped still would otherwise set the graph's clock at image2's default 25 fps and
    // the 30 fps footage would be resampled (7.20 s came out 7.12 s); run it at the clip's rate.
    const fps = alphaInfo.fps || rgbInfo.fps || srcInfo.fps || 25;
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg()
        .input(bgPath).inputOptions(['-loop 1', `-framerate ${fps}`])
        .input(rgbPath)
        .input(alphaPath);
      if (haveAudio) cmd.input(srcPath);
      const out = ['-map [out]'];
      if (haveAudio) out.push('-map 3:a?', '-c:a aac', '-b:a 160k');
      // No `-shortest`: on the deployed ffmpeg 4.1 it cut the tail (7.20 s → 6.97 s) while the
      // 4.4 build kept every frame. The looped still is already bounded by overlay's
      // shortest=1, and the audio is the footage's own, so nothing here runs long.
      out.push(`-r ${fps}`, '-c:v libx264', '-preset veryfast', '-crf 19', '-pix_fmt yuv420p', '-movflags +faststart');
      cmd
        .complexFilter(`${fgChain};${bgChain}`)
        .outputOptions(out)
        .on('start', (line: string) => console.log('[VFX composite]', line))
        .on('end', () => resolve())
        .on('error', (err: any) => reject(new Error(`ffmpeg composite: ${err?.message || err}`)))
        .save(outPath);
    });
    return fs.readFileSync(outPath);
  } finally {
    for (const p of [rgbPath, alphaPath, bgPath, srcPath, outPath]) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }
}

/** Whole-frame grade for clips a model already re-rendered (O3 edit). Audio copied. On
 *  failure the ungraded clip ships — a finished shot beats no shot. */
export async function gradeVideo(input: Buffer, grade: string): Promise<any> {
  const chain = gradeChain(grade);
  if (!chain) return input;
  const dir = os.tmpdir();
  const inPath = path.join(dir, `grade_in_${Date.now()}.mp4`);
  const outPath = path.join(dir, `grade_out_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(inPath, input);
    await new Promise<void>((resolve, reject) => {
      ffmpeg().input(inPath)
        .outputOptions(['-vf ' + chain, '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-c:a copy', '-movflags +faststart'])
        .on('end', () => resolve()).on('error', (err: any) => reject(err)).save(outPath);
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    console.warn('[VFX grade] failed, shipping ungraded clip:', err);
    return input;
  } finally {
    for (const p of [inPath, outPath]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}

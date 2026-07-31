import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

// Configure ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300; // 5 minutes max duration
export const dynamic = 'force-dynamic';

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`[Merge API] Downloading temporary file from: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ดาวน์โหลดไฟล์ไม่สำเร็จ: ${response.statusText} (${url})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(destPath, buffer);
}

// Native image dimension parsing helpers to avoid heavy external dependencies
function getPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504E47 || buffer.readUInt32BE(4) !== 0x0D0A1A0A) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function getJpgDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4) return null;
  if (buffer.readUInt16BE(0) !== 0xFFD8) {
    return null;
  }
  let offset = 2;
  while (offset < buffer.length - 8) {
    const marker = buffer.readUInt16BE(offset);
    if (marker === 0xFFD9) {
      break;
    }
    const isSOF = marker >= 0xFFC0 && marker <= 0xFFCF && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC;
    const length = buffer.readUInt16BE(offset + 2);
    if (isSOF) {
      if (offset + 8 >= buffer.length) break;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function getWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const type = buffer.toString('ascii', 12, 16);
  if (type === 'VP8 ') {
    const width = buffer.readUInt16LE(26) & 0x3FFF;
    const height = buffer.readUInt16LE(28) & 0x3FFF;
    return { width, height };
  } else if (type === 'VP8L') {
    const val = buffer.readUInt32LE(21);
    const width = (val & 0x3FFF) + 1;
    const height = ((val >> 14) & 0x3FFF) + 1;
    return { width, height };
  } else if (type === 'VP8X') {
    const width = (buffer.readUInt32LE(24) & 0xFFFFFF) + 1;
    const height = (buffer.readUInt32LE(27) & 0xFFFFFF) + 1;
    return { width, height };
  }
  return null;
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } {
  try {
    const png = getPngDimensions(buffer);
    if (png) return png;
    const jpg = getJpgDimensions(buffer);
    if (jpg) return jpg;
    const webp = getWebpDimensions(buffer);
    if (webp) return webp;
  } catch (e) {
    console.error('[Merge API] Error parsing image dimensions from buffer:', e);
  }
  return { width: 1280, height: 720 };
}

export async function POST(req: NextRequest) {
  const tempFiles: string[] = [];
  let tempDir = '';

  try {
    const body = await req.json();
    const { videoUrls, user_email, user_id, title, aspectRatio, baseImageUrl, faceTags, normalize, trimSilence } = body;
    let videoClips = body.videoClips;

    // Backward compatibility with Phase 1 payload
    if (!videoClips && videoUrls && Array.isArray(videoUrls)) {
      videoClips = videoUrls.map((url: string) => ({
        videoUrl: url,
        cropX: null,
        cropY: null,
        cropW: null,
        cropH: null
      }));
    }

    // Validate payload
    // One clip is allowed: a scene can hold a single line and still need compositing
    // onto its background image before scenes are joined.
    if (!videoClips || !Array.isArray(videoClips) || videoClips.length < 1) {
      return NextResponse.json(
        { success: false, error: 'กรุณาส่งรายการคลิปวิดีโออย่างน้อย 1 รายการ' },
        { status: 400 }
      );
    }
    if (!user_email || !user_id) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลผู้ใช้ไม่ถูกต้อง (กรุณาระบุ user_email และ user_id)' },
        { status: 400 }
      );
    }

    console.log(`[Merge API] Starting merge task for user: ${user_email}. Number of clips: ${videoClips.length}`);

    // Create unique temp directory
    const timestamp = Date.now();
    tempDir = path.join(os.tmpdir(), `kruth-merge-${timestamp}-${Math.random().toString(36).substring(2, 7)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download all clips in parallel to save time
    console.log(`[Merge API] Downloading ${videoClips.length} clips in parallel...`);
    const localClipPaths: string[] = [];
    await Promise.all(
      videoClips.map(async (clip: any, i: number) => {
        const localPath = path.join(tempDir, `clip_${i}_orig.mp4`);
        await downloadFile(clip.videoUrl, localPath);
        localClipPaths[i] = localPath;
        tempFiles.push(localPath);
      })
    );

    // Download and parse base image if provided
    let localBaseImagePath = '';
    let bgW = 1280;
    let bgH = 720;
    if (baseImageUrl) {
      localBaseImagePath = path.join(tempDir, 'base_image_bg.png');
      await downloadFile(baseImageUrl, localBaseImagePath);
      tempFiles.push(localBaseImagePath);

      try {
        const imgBuffer = await fs.promises.readFile(localBaseImagePath);
        const dims = getImageDimensions(imgBuffer);
        bgW = dims.width;
        bgH = dims.height;
        console.log(`[Merge API] Successfully parsed base image dimensions: ${bgW}x${bgH}`);
      } catch (err) {
        console.warn(`[Merge API] Failed to parse base image dimensions, using 1280x720 fallback:`, err);
      }
    }

    const evenBgW = bgW % 2 === 0 ? bgW : bgW + 1;
    const evenBgH = bgH % 2 === 0 ? bgH : bgH + 1;

    // Models render clips of fixed lengths, so a short line leaves dead air at the end.
    // Find where speech actually stops instead of trusting a character-count estimate:
    // if the clip ends in silence, cut just after the last sound (keeping a short tail).
    const TAIL_PADDING = 0.4;
    const MIN_TRIM_GAIN = 0.8; // don't re-encode to shave off less than this
    const findSpeechEnd = (filePath: string): Promise<number | null> =>
      new Promise((resolve) => {
        // ffmpeg writes silencedetect results to stderr; read them directly rather than
        // through the wrapper, which does not surface them for a null-muxer run.
        execFile(
          ffmpegInstaller.path,
          ['-i', filePath, '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-'],
          { maxBuffer: 8 * 1024 * 1024 },
          (_err, _stdout, stderr) => {
            const log = stderr || '';
            const durMatch = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            const total = durMatch
              ? (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + parseFloat(durMatch[3])
              : null;
            if (!total) return resolve(null);

            const collect = (re: RegExp) => {
              const out: number[] = [];
              let m: RegExpExecArray | null;
              while ((m = re.exec(log)) !== null) out.push(parseFloat(m[1]));
              return out;
            };
            const starts = collect(/silence_start:\s*([\d.]+)/g);
            const ends = collect(/silence_end:\s*([\d.]+)/g);
            if (starts.length === 0) return resolve(null);

            // ffmpeg also reports a silence_end at EOF, so a silence is "trailing" when its
            // end lands at the end of the file — not when the end is missing.
            const lastStart = starts[starts.length - 1];
            const lastEnd = ends.length ? ends[ends.length - 1] : total;
            const runsToEof = lastEnd >= total - 0.25;
            if (!runsToEof || lastStart >= total) return resolve(null);

            const cut = Math.min(total, lastStart + TAIL_PADDING);
            if (total - cut < MIN_TRIM_GAIN) return resolve(null);
            return resolve(cut);
          }
        );
      });

    // Process segments
    const localVideoPaths: string[] = [];

    for (let i = 0; i < videoClips.length; i++) {
      const clip = videoClips[i];
      const localClipPath = localClipPaths[i];
      const segmentPath = path.join(tempDir, `segment_${i}.mp4`);

      const trimTo = trimSilence ? await findSpeechEnd(localClipPath) : null;
      if (trimTo) {
        console.log(`[Merge API] Clip ${i}: trimming trailing silence at ${trimTo.toFixed(2)}s`);
      }
      const trimOpts = trimTo ? [`-t ${trimTo.toFixed(2)}`] : [];

      // If no base image, or clip does not have coordinates, we don't overlay
      if (!baseImageUrl) {
        if (!normalize && !trimTo) {
          // Direct Phase 1 concatenation: use downloaded clip directly
          localVideoPaths.push(localClipPath);
          continue;
        }
        if (!normalize && trimTo) {
          // Only the tail needs removing — copy the streams instead of re-encoding
          await new Promise<void>((resolve, reject) => {
            ffmpeg(localClipPath)
              .outputOptions(['-t ' + trimTo.toFixed(2), '-c copy'])
              .on('end', () => resolve())
              .on('error', (err) => reject(err))
              .save(segmentPath);
          });
          localVideoPaths.push(segmentPath);
          tempFiles.push(segmentPath);
          continue;
        }

        // Normalized concatenation: sources may differ in size (e.g. joining scenes that each
        // used their own background). The concat demuxer needs identical streams, so fit every
        // clip into the project frame, padding with black instead of distorting it.
        const [normW, normH] = aspectRatio === '9:16'
          ? [720, 1280]
          : aspectRatio === '1:1'
            ? [1024, 1024]
            : [1280, 720];
        console.log(`[Merge API] Normalizing clip ${i} to ${normW}x${normH} before concat`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(localClipPath)
            .complexFilter([
              `[0:v]scale=${normW}:${normH}:force_original_aspect_ratio=decrease,pad=${normW}:${normH}:(ow-iw)/2:(oh-ih)/2,setsar=1[out]`
            ])
            .outputOptions([
              '-map [out]',
              '-map 0:a?',
              '-c:v libx264',
              '-preset veryfast',
              '-pix_fmt yuv420p',
              '-r 25',
              '-c:a aac',
              '-ar 44100',
              '-ac 2',
              ...trimOpts
            ])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(segmentPath);
        });
        localVideoPaths.push(segmentPath);
        tempFiles.push(segmentPath);
        continue;
      }

      if (clip.cropX === null || clip.cropX === undefined) {
        // Unlinked clip in a base-image scenario: scale the clip to match the base image size
        console.log(`[Merge API] Clip ${i} is unlinked. Scaling full screen to match background size ${evenBgW}x${evenBgH}`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(localClipPath)
            .complexFilter([
              `[0:v]scale=${evenBgW}:${evenBgH}[scaled]`
            ])
            .outputOptions([
              '-map [scaled]',
              '-map 0:a?',
              '-c:v libx264',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-ar 44100',
              '-ac 2',
              ...trimOpts
            ])
            .save(segmentPath)
            .on('start', (cmd) => {
              console.log(`[Merge API] FFmpeg Segment ${i} Command: ${cmd}`);
            })
            .on('end', () => {
              console.log(`[Merge API] Segment ${i} scaled successfully.`);
              resolve();
            })
            .on('error', (err) => {
              console.error(`[Merge API] FFmpeg Segment ${i} error:`, err);
              reject(new Error(`การสเกลวิดีโอ Segment ${i} ล้มเหลว: ${err.message}`));
            });
        });
        localVideoPaths.push(segmentPath);
        tempFiles.push(segmentPath);
      } else {
        // Linked clip: overlay the scaled clip onto the base image
        const x = Math.round(clip.cropX * bgW);
        const y = Math.round(clip.cropY * bgH);
        const w = Math.round(clip.cropW * bgW);
        const h = Math.round(clip.cropH * bgH);
        const finalW = w % 2 === 0 ? w : w + 1;
        const finalH = h % 2 === 0 ? h : h + 1;

        console.log(`[Merge API] Clip ${i} is linked. Overlaying at coordinates x=${x}, y=${y}, w=${finalW}, h=${finalH}`);

        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(localBaseImagePath)
            .inputOptions(['-loop 1'])
            .input(localClipPath)
            .complexFilter([
              `[0:v]scale=2*trunc(iw/2):2*trunc(ih/2)[bg]`,
              `[1:v]scale=${finalW}:${finalH}[face]`,
              `[bg][face]overlay=${x}:${y}:shortest=1[outv]`
            ])
            .outputOptions([
              '-map [outv]',
              '-map 1:a?',
              '-c:v libx264',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-ar 44100',
              '-ac 2',
              '-shortest',
              ...trimOpts
            ])
            .save(segmentPath)
            .on('start', (cmd) => {
              console.log(`[Merge API] FFmpeg Segment ${i} Command: ${cmd}`);
            })
            .on('end', () => {
              console.log(`[Merge API] Segment ${i} overlaid successfully.`);
              resolve();
            })
            .on('error', (err) => {
              console.error(`[Merge API] FFmpeg Segment ${i} error:`, err);
              reject(new Error(`การทำ Overlay สำหรับ Segment ${i} ล้มเหลว: ${err.message}`));
            });
        });
        localVideoPaths.push(segmentPath);
        tempFiles.push(segmentPath);
      }
    }

    // Write concat.txt for FFmpeg concat demuxer
    const concatTxtContent = localVideoPaths
      .map(p => `file '${p.replace(/\\/g, '/')}'`)
      .join('\n');
    const concatTxtPath = path.join(tempDir, 'concat_list.txt');
    await fs.promises.writeFile(concatTxtPath, concatTxtContent, 'utf-8');
    tempFiles.push(concatTxtPath);

    console.log(`[Merge API] Created concat list file at: ${concatTxtPath}`);
    console.log(concatTxtContent);

    // Perform FFmpeg merge using concat demuxer
    const outputPath = path.join(tempDir, 'merged_output.mp4');
    tempFiles.push(outputPath);

    console.log(`[Merge API] Running FFmpeg concat process...`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatTxtPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions('-c copy')
        .save(outputPath)
        .on('start', (commandLine) => {
          console.log(`[Merge API] FFmpeg Concat Command: ${commandLine}`);
        })
        .on('end', () => {
          console.log(`[Merge API] FFmpeg concat successfully finished.`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[Merge API] FFmpeg concat error:`, err);
          reject(new Error(`การรวมไฟล์วิดีโอด้วย FFmpeg ล้มเหลว: ${err.message}`));
        });
    });

    // Read output file buffer
    const mergedBuffer = await fs.promises.readFile(outputPath);
    console.log(`[Merge API] Merged video size: ${mergedBuffer.length} bytes`);

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Upload to Supabase Storage
    const storagePath = `videos/${user_email}/${timestamp}_merged.mp4`;
    console.log(`[Merge API] Uploading merged video to Supabase Storage: ${storagePath}`);
    
    const { error: uploadError } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(storagePath, mergedBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`อัปโหลดไฟล์วิดีโอที่รวมเสร็จแล้วขึ้น Supabase Storage ไม่สำเร็จ: ${uploadError.message}`);
    }

    // Get Public URL
    const { data: { publicUrl } } = supabase.storage
      .from('kruth-ai-assets')
      .getPublicUrl(storagePath);
    console.log(`[Merge API] Uploaded successfully. Public URL: ${publicUrl}`);

    // Ensure profiles table has a row for this user
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user_id)
        .single();
      
      if (!profile) {
        console.log(`[Merge API] Creating missing profile row for user: ${user_id}`);
        await supabase
          .from('profiles')
          .insert({
            id: user_id,
            email: user_email,
            role: user_email === 'whootthira@gmail.com' ? 'admin' : 'user'
          });
      }
    } catch (e) {
      console.warn('[Merge API] Error verifying profile:', e);
    }

    // Log generation record in DB
    const finalTitle = title || `คลิปบทสนทนารวม ${videoClips.length} ประโยค`;
    const { error: dbError } = await supabase
      .from('generations')
      .insert({
        user_id: user_id,
        prompt: finalTitle,
        audio_prompt: null,
        source_image_url: '',
        status: 'completed',
        video_url: publicUrl,
        metadata: {
          mode: 'dialogue-merged',
          title: finalTitle,
          video_urls: videoClips.map((c: any) => c.videoUrl),
          video_clips: videoClips,
          aspect_ratio: aspectRatio || '16:9',
          storage_path: storagePath,
          duration_estimate: 0,
          base_image_url: baseImageUrl || null,
          face_tags: faceTags || null
        }
      });

    if (dbError) {
      console.error('[Merge API] Error inserting generation record to Supabase:', dbError);
    }

    return NextResponse.json({
      success: true,
      videoUrl: publicUrl,
      storagePath
    });

  } catch (error: any) {
    console.error(`[Merge API Exception]:`, error.message || error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดภายในระบบสำหรับการรวมวิดีโอ' },
      { status: 500 }
    );
  } finally {
    // Cleanup temp files and temp directory
    console.log(`[Merge API] Cleaning up temporary files...`);
    for (const filePath of tempFiles) {
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch (e) {
        console.warn(`[Merge API] Failed to delete temp file: ${filePath}`, e);
      }
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        await fs.promises.rmdir(tempDir);
      } catch (e) {
        console.warn(`[Merge API] Failed to delete temp directory: ${tempDir}`, e);
      }
    }
  }
}


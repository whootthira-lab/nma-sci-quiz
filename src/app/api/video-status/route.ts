import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { baseAppId, falStatus, falResult, falSubmitCompat } from '@/lib/providers/fal';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Configure ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Completing a job means pulling the finished file and storing it, which is far more
// than the default execution window allows — without this the request is cut off at 10s
// and, because every poll retries the same work, it fails on every attempt.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Kling's own lip-sync: measured head-to-head against sync-lipsync v3 on the same base
// video and audio — mouth closed through both silent paddings, open mid-word during
// speech, same facial fidelity, fuller frame — at $0.014/second against v3's $0.1333,
// which alone was 59% of the August bill.
const LIPSYNC_ENDPOINT = 'fal-ai/kling-video/lipsync/audio-to-video';
const AMBIENT_ENDPOINT = 'fal-ai/mmaudio-v2'; // scores SILENT clips from their visuals
// Speech clips get their ambience from a pure text-to-audio model instead: mmaudio watches
// the video, and a video of someone talking tempts it into murmurs and music that smear
// into the voice. Stable Audio never sees the mouth — it renders the scene prompt alone,
// and the mix keeps the voice untouched on top.
const AMBIENT_TTA_ENDPOINT = 'fal-ai/stable-audio';
const FACE_RESTORE_ENDPOINT = 'fal-ai/face-swap';


/** Remux with the audio held back by `seconds`; video copied bit-for-bit. On any failure
 *  the original clip goes through — slightly early sound beats a failed generation. */
async function delayAudioTrack(input: Buffer, seconds: number): Promise<any> {
  const dir = os.tmpdir();
  const inPath = path.join(dir, `avshift_in_${Date.now()}.mp4`);
  const outPath = path.join(dir, `avshift_out_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(inPath, input);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(inPath)
        .input(inPath)
        // fluent-ffmpeg applies inputOptions to the most recently added input — the audio one
        .inputOptions([`-itsoffset ${seconds}`])
        .outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-ar 44100', '-shortest'])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(outPath);
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    console.warn('[AV Shift] Failed to delay audio, keeping original clip:', err);
    return input;
  } finally {
    for (const p of [inPath, outPath]) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }
}

/** Lay the narration track over a silent scene clip; video copied bit-for-bit. Uses only
 *  options the 2018 deployed ffmpeg has. On failure the silent clip ships — footage
 *  without narration beats no footage. */
async function muxNarration(video: Buffer, audioUrl: string): Promise<any> {
  const dir = os.tmpdir();
  const vPath = path.join(dir, `nar_v_${Date.now()}.mp4`);
  const aPath = path.join(dir, `nar_a_${Date.now()}.mp3`);
  const outPath = path.join(dir, `nar_out_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(vPath, video);
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error('audio fetch ' + res.status);
    fs.writeFileSync(aPath, Buffer.from(await res.arrayBuffer()));
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(vPath)
        .input(aPath)
        .outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-ar 44100', '-shortest'])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(outPath);
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    console.warn('[Narration Mux] Failed, shipping the silent clip:', err);
    return video;
  } finally {
    for (const p of [vPath, aPath, outPath]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}

/** Mix the scored clip's ambience UNDER the speech clip's own track — speech stays in
 *  front, room tone sits at ~22%. Video stream copied from the speech clip untouched.
 *  Any failure ships the speech-only clip. */
async function mixAmbientUnder(speechClip: Buffer, ambientClip: Buffer): Promise<any> {
  const dir = os.tmpdir();
  const sPath = path.join(dir, `amb_s_${Date.now()}.mp4`);
  const aPath = path.join(dir, `amb_a_${Date.now()}.mp4`);
  const outPath = path.join(dir, `amb_out_${Date.now()}.mp4`);
  try {
    fs.writeFileSync(sPath, speechClip);
    fs.writeFileSync(aPath, ambientClip);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(sPath)
        .input(aPath)
        .outputOptions([
          '-filter_complex [1:a]volume=0.22[amb];[0:a][amb]amix=inputs=2:duration=first:dropout_transition=0[aout]',
          '-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-ar 44100'
        ])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(outPath);
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    console.warn('[Ambient Mix] Failed, shipping the speech-only clip:', err);
    return speechClip;
  } finally {
    for (const p of [sPath, aPath, outPath]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}

/** Colour grades as filter chains the 2018 deployed ffmpeg has (eq, colorbalance). */
function gradeChain(grade: string): string {
  switch (grade) {
    case 'warm': return 'colorbalance=rs=0.10:gs=0.03:bs=-0.10:rm=0.06:bm=-0.06,eq=saturation=1.05';
    case 'cool': return 'colorbalance=rs=-0.06:bs=0.10:rm=-0.04:bm=0.06';
    case 'cinematic': return 'eq=contrast=1.08:saturation=0.88,colorbalance=rs=-0.08:gs=-0.02:bs=0.10:bm=0.02:rh=0.10:gh=0.03:bh=-0.10';
    default: return '';
  }
}

async function fetchToFile(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์ไม่สำเร็จ (${res.status}): ${url.slice(0, 80)}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * VFX background replacement, matte engine. veed's h264 mode hands back the person as an
 * RGB clip plus a separate alpha clip; the old ffmpeg cannot decode VP9 alpha but it can
 * `alphamerge` two ordinary streams, so: grade the person, merge the alpha in, size the
 * background image to the footage, overlay, and put the footage's own audio back.
 * The composite IS the product here, so a failure is reported rather than shipped around.
 */
async function compositeBackground(
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

    const g = gradeChain(grade);
    const fgChain = `[1:v]${g ? g + ',' : ''}format=rgba[fg];[2:v]format=gray[a];[fg][a]alphamerge[fga]`;
    // Background sized to the footage: exact when the client measured the footage, else
    // stretched to the foreground's own size (the image was made at the same aspect).
    const bgChain = width && height
      ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg];[bg][fga]overlay=0:0:shortest=1:format=yuv420[out]`
      : `[0:v][fga]scale2ref[bg][fga2];[bg][fga2]overlay=0:0:shortest=1:format=yuv420[out]`;

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg()
        .input(bgPath).inputOptions(['-loop 1'])
        .input(rgbPath)
        .input(alphaPath);
      if (haveAudio) cmd.input(srcPath);
      const out = ['-map [out]'];
      if (haveAudio) out.push('-map 3:a?', '-c:a aac', '-b:a 160k');
      out.push('-c:v libx264', '-preset veryfast', '-crf 19', '-pix_fmt yuv420p', '-movflags +faststart', '-shortest');
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
async function gradeVideo(input: Buffer, grade: string): Promise<any> {
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

async function uploadToFirebaseStorage(
  buffer: Buffer,
  path: string,
  contentType: string
): Promise<string> {
  try {
    const { adminStorage } = await import('../../../lib/admin');
    const bucket = adminStorage.bucket();
    const file = bucket.file(path);

    await file.save(buffer, { 
      contentType,
      public: true,
      metadata: { cacheControl: 'public, max-age=31536000' }
    });

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000,
    });

    return url;
  } catch (error) {
    console.error(`[Firebase Storage Error] ไม่สามารถอัปโหลดไฟล์ไปที่: ${path}`, error);
    throw new Error('อัปโหลดไฟล์ขึ้น Firebase ไม่สำเร็จ');
  }
}

export async function POST(req: NextRequest) {
  try {
    const { requestId, videoPath, modelType, storageProvider, modelEndpoint: clientModelEndpoint } = await req.json();
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY || '';

    if (!requestId || !videoPath) {
      return NextResponse.json({ status: 'ERROR', error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    // Supabase client initialization to check if lipsync is active
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let genRow: any = null;
    try {
      const { data: dbGenRow } = await supabase
        .from('generations')
        .select('*')
        .eq('fal_request_id', requestId)
        .single();
      genRow = dbGenRow;
    } catch (dbErr) {
      console.warn('[Supabase DB Read] Could not find or read generation metadata:', dbErr);
    }

    // Prefer the exact endpoint stored in DB, then the one the client passes (covers image
    // sub-endpoints like image-to-image / fill that modelType alone can't distinguish),
    // then fall back to inferring from modelType.
    let modelEndpoint = genRow?.metadata?.model_endpoint || clientModelEndpoint || '';
    if (!modelEndpoint) {
      const isCinema = modelType === 'cinema';
      const isMotionControl = modelType === 'motion-control';
      const isGrok = modelType === 'grok-video';
      const isSeedance = modelType === 'seedance';
      const isFluxSchnell = modelType === 'flux_schnell';
      const isFlux = modelType?.includes('flux') || modelType === 'fill';
      modelEndpoint = isSeedance
        ? 'fal-ai/bytedance/seedance/v1/pro/image-to-video'
        : isCinema
        ? 'fal-ai/wan-i2v'
        : (isMotionControl
            ? 'fal-ai/kling-video/v2.6/standard/motion-control'
            : (isGrok
                ? 'xai/grok-imagine-video/v1.5/image-to-video'
                : (isFlux
                    ? (isFluxSchnell ? 'fal-ai/flux/schnell' : 'fal-ai/flux/dev')
                    : 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video'
                  )
              )
          );
    }

    const queueNamespace = baseAppId(modelEndpoint);

    const lipsyncRequestId = genRow?.metadata?.lipsync_request_id;
    const ambientRequestId = genRow?.metadata?.ambient_request_id;
    // Ambient outranks lip-sync: for speech clips the score is added AFTER the lip-synced
    // clip is finished, so once its request id exists that is the phase being awaited —
    // the old precedence would re-enter the completed lip-sync round forever.
    const isAmbientPhase = !!ambientRequestId;
    const isLipsyncPhase = !isAmbientPhase && !!lipsyncRequestId;
    const faceRestoreRequestId = genRow?.metadata?.face_restore_request_id;
    const isFaceRestorePhase = !isLipsyncPhase && !isAmbientPhase && !!faceRestoreRequestId;

    const apiProvider = genRow?.metadata?.api_provider || 'fal';

    let statusData: any = null;
    let currentStatus = '';

    if (isFaceRestorePhase) {
      // Putting the original face back runs as its own queued job, like the other passes
      const st = await falStatus(FACE_RESTORE_ENDPOINT, faceRestoreRequestId);
      const checkResponse = { ok: st.ok, status: st.httpStatus, json: async () => st.data } as any;
      if (!checkResponse.ok) {
        console.error(`[Face Restore Status Fail] status: ${checkResponse.status}`);
        return NextResponse.json({ status: 'WAITING' });
      }
      statusData = await checkResponse.json();
      currentStatus = statusData.status;
    } else if (isAmbientPhase) {
      // Scoring a silent clip runs as its own queued job, exactly like lip-sync
      const ambientEndpointUsed = genRow?.metadata?.ambient_endpoint || AMBIENT_ENDPOINT;
      const st = await falStatus(ambientEndpointUsed, ambientRequestId);
      const checkResponse = { ok: st.ok, status: st.httpStatus, json: async () => st.data } as any;
      if (!checkResponse.ok) {
        console.error(`[Ambient Status Fail] status: ${checkResponse.status}`);
        if (checkResponse.status === 404 || checkResponse.status === 405) {
          return NextResponse.json({
            status: 'ERROR',
            error: `ที่อยู่สำหรับตรวจสถานะเสียงบรรยากาศไม่ถูกต้อง (${checkResponse.status})`
          }, { status: 500 });
        }
        return NextResponse.json({ status: 'WAITING' });
      }
      statusData = await checkResponse.json();
      currentStatus = statusData.status;
    } else if (isLipsyncPhase) {
      // 1. Fetch official queue status endpoint for Lipsync (always on Fal.ai)
      const st = await falStatus(LIPSYNC_ENDPOINT, lipsyncRequestId);
      const checkResponse = { ok: st.ok, status: st.httpStatus, json: async () => st.data } as any;

      if (!checkResponse.ok) {
        console.error(`[Lipsync Status Fail] status: ${checkResponse.status}`);
        if (checkResponse.status === 401 || checkResponse.status === 403) {
          return NextResponse.json({ 
            status: 'ERROR', 
            error: 'สิทธิ์การใช้งาน Fal.ai (FAL_KEY) ไม่ถูกต้อง หรือหมดอายุ' 
          }, { status: checkResponse.status });
        }
        // A wrong queue address never becomes right by waiting: report it instead of
        // spinning forever, which is how the namespace bugs used to present.
        if (checkResponse.status === 404 || checkResponse.status === 405) {
          return NextResponse.json({
            status: 'ERROR',
            error: `ที่อยู่สำหรับตรวจสถานะซิงก์ปากไม่ถูกต้อง (${checkResponse.status})`
          }, { status: 500 });
        }
        return NextResponse.json({ status: 'WAITING' });
      }

      statusData = await checkResponse.json();
      currentStatus = statusData.status;
    } else if (apiProvider === 'siliconflow') {
      // 2. Fetch SiliconFlow status
      const sfKey = process.env.SILICONFLOW_API_KEY || process.env.NEXT_PUBLIC_SILICONFLOW_API_KEY || '';
      const checkResponse = await fetch('https://api.siliconflow.com/v1/video/status', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId }),
        cache: 'no-store'
      });

      if (!checkResponse.ok) {
        console.error(`[SiliconFlow Status Fail] status: ${checkResponse.status}`);
        return NextResponse.json({ status: 'WAITING' });
      }

      statusData = await checkResponse.json();
      // SiliconFlow status values: Succeed, Failed, InQueue, InProgress
      const sfStatus = statusData.status;
      if (sfStatus === 'Succeed') {
        currentStatus = 'COMPLETED';
      } else if (sfStatus === 'Failed') {
        currentStatus = 'FAILED';
      } else if (sfStatus === 'InQueue') {
        currentStatus = 'IN_QUEUE';
      } else {
        currentStatus = 'IN_PROGRESS';
      }
    } else {
      // 3. Fetch Fal.ai status
      const checkUrl = `https://queue.fal.run/${queueNamespace}/requests/${requestId}/status`;
      const st = await falStatus(modelEndpoint, requestId);
      const checkResponse = { ok: st.ok, status: st.httpStatus, json: async () => st.data } as any;

      if (!checkResponse.ok) {
        console.error(`[KRUTH Status Fail] ${checkUrl} → ${checkResponse.status}`);
        if (checkResponse.status === 401 || checkResponse.status === 403) {
          return NextResponse.json({ 
            status: 'ERROR', 
            error: 'สิทธิ์การใช้งาน Fal.ai (FAL_KEY) ไม่ถูกต้อง หรือหมดอายุ' 
          }, { status: checkResponse.status });
        }
        // A wrong queue address never becomes right by waiting: report it instead of
        // spinning forever, which is how the namespace bugs used to present.
        if (checkResponse.status === 404 || checkResponse.status === 405) {
          return NextResponse.json({
            status: 'ERROR',
            error: `ที่อยู่สำหรับตรวจสถานะของโมเดลนี้ไม่ถูกต้อง (${checkResponse.status}) — ${queueNamespace}`
          }, { status: 500 });
        }
        return NextResponse.json({ status: 'WAITING' });
      }

      statusData = await checkResponse.json();
      currentStatus = statusData.status;
    }

    if (currentStatus === 'COMPLETED') {
      let tempUrl = '';
      let matteAlphaUrl = ''; // veed h264 mode: second clip carrying the person's alpha

      if (apiProvider === 'siliconflow' && !isLipsyncPhase) {
        tempUrl = statusData.results?.videos?.[0]?.url;
      } else {
        const detailUrl = statusData.response_url || (isFaceRestorePhase
          ? `https://queue.fal.run/${baseAppId(FACE_RESTORE_ENDPOINT)}/requests/${faceRestoreRequestId}`
          : isAmbientPhase
          ? `https://queue.fal.run/${baseAppId(genRow?.metadata?.ambient_endpoint || AMBIENT_ENDPOINT)}/requests/${ambientRequestId}`
          : isLipsyncPhase
          ? `https://queue.fal.run/${baseAppId(LIPSYNC_ENDPOINT)}/requests/${lipsyncRequestId}`
          : `https://queue.fal.run/${queueNamespace}/requests/${requestId}`);

        const dr = await falResult(modelEndpoint, requestId, detailUrl);
        const detailResponse = { ok: dr.ok, status: dr.httpStatus, json: async () => dr.data, text: async () => dr.text } as any;
        
        if (!detailResponse.ok) {
          const errorText = await detailResponse.text();
          console.error(`[Fal.ai Queue Detail Error] Status: ${detailResponse.status}, Response:`, errorText);

          // A 422 here is the model rejecting the job's parameters. Retrying can't fix that,
          // and the payload says exactly which field is wrong — report it and stop rather
          // than letting the caller exhaust its retries against a permanent failure.
          if (detailResponse.status === 422) {
            let why = errorText.slice(0, 300);
            try {
              const parsed = JSON.parse(errorText);
              const detail = parsed?.detail;
              if (Array.isArray(detail)) {
                why = detail
                  .map((d: any) => `${(d.loc || []).filter((p: any) => p !== 'body').join('.')}: ${d.msg}`)
                  .join(' | ')
                  .slice(0, 300);
              } else if (typeof detail === 'string') {
                why = detail.slice(0, 300);
              }
            } catch {
              /* keep the raw text */
            }

            await supabase
              .from('generations')
              .update({
                status: 'failed',
                error_message: `Fal rejected the request: ${why}`,
                updated_at: new Date().toISOString()
              })
              .eq('fal_request_id', requestId);

            // The commonest rejection deserves a message in the user's language with a way
            // forward, not a relayed English validator string.
            const contentFlagged = /content checker|flagged|could not be processed/i.test(why);
            return NextResponse.json({
              status: 'FAILED',
              error: contentFlagged
                ? 'รูปต้นฉบับไม่ผ่านระบบคัดกรองเนื้อหาของโมเดลนี้ (เจอได้กับรูปคนจริงแม้เนื้อหาปกติ) — ลองครอปรูปใหม่ให้เห็นเฉพาะช่วงไหล่ขึ้นไป เปลี่ยนรูปอื่น หรือเปลี่ยนโมเดลในเมนู "โมเดล AI ที่ใช้แก้ภาพ" เพราะแต่ละค่ายคัดกรองต่างกัน'
                : `ระบบ AI ปฏิเสธคำสั่งนี้ — ${why}`,
              progressMessage: '❌ ล้มเหลว'
            });
          }

          throw new Error(`ไม่สามารถดึงผลลัพธ์จาก Fal.ai ได้ (status: ${detailResponse.status})`);
        }

        const detailData = await detailResponse.json();
        if (Array.isArray(detailData.video)) {
          // Two clips (RGB + alpha). Named when the provider names them; else in that order.
          const vids = detailData.video as any[];
          const alpha = vids.find((v) => /alpha|mask/i.test(v?.file_name || v?.url || '')) || vids[1];
          const rgbClip = vids.find((v) => v !== alpha) || vids[0];
          tempUrl = rgbClip?.url || '';
          matteAlphaUrl = alpha?.url || '';
          console.log('[VFX] matte outputs:', vids.map((v) => v?.file_name || v?.url));
        } else {
          tempUrl = detailData.video?.url || detailData.output?.video?.url || detailData.audio_file?.url || detailData.audio?.url || detailData.images?.[0]?.url || detailData.image?.url;
        }
      }

      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      let finalStorageProvider = storageProvider;
      if (!finalStorageProvider) {
        finalStorageProvider = genRow?.metadata?.storage_provider || 'supabase';
      }

      const audioUrl = genRow?.audio_prompt;
      const isNoSpeech = genRow?.metadata?.is_no_speech === true;
      const isNarration = genRow?.metadata?.narration_only === true;
      const isAvatar = genRow?.metadata?.avatar_mode === true;

      // Turning a viewpoint drifts a likeness even with the strongest model, so put the
      // original face back over the result — as its own queued job, like the passes below.
      const faceRestorePending = genRow?.metadata?.face_restore_pending === true;
      const faceSource = genRow?.metadata?.face_restore_source;
      if (!isFaceRestorePhase && faceRestorePending && faceSource && tempUrl) {
        console.log('[Face Restore] Putting the original face back over the rotated result');
        try {
          const fsRes = await falSubmitCompat(FACE_RESTORE_ENDPOINT, { base_image_url: tempUrl, swap_image_url: faceSource });
          if (!fsRes.ok) throw new Error(`face restore submit failed: ${fsRes.status}`);
          const fsJson = await fsRes.json();
          if (!fsJson.request_id) throw new Error('face restore job returned no request id');

          await supabase
            .from('generations')
            .update({
              metadata: {
                ...(genRow?.metadata || {}),
                face_restore_request_id: fsJson.request_id,
                face_restore_pending: false,
                pre_restore_url: tempUrl
              },
              updated_at: new Date().toISOString()
            })
            .eq('fal_request_id', requestId);

          return NextResponse.json({
            status: 'IN_QUEUE',
            progressMessage: 'กำลังคืนใบหน้าต้นฉบับ...',
            progressPercent: 90
          });
        } catch (fsErr: any) {
          // The rotated image is still a usable result; keep it rather than failing
          console.error('[Face Restore] skipped:', fsErr?.message || fsErr);
        }
      }

      // A silent clip from an engine that can't score itself gets a soundtrack now, as its
      // own queued job — the previous attempt at this ran inline and timed out, so it never
      // blocks this request.
      const ambientPending = genRow?.metadata?.ambient_pending === true;
      if (!isLipsyncPhase && !isAmbientPhase && ambientPending && isNoSpeech && tempUrl) {
        const ambientPrompt = genRow?.metadata?.ambient_prompt || 'natural ambience matching the scene';
        console.log(`⏳ [Ambient] Scoring silent clip via ${AMBIENT_ENDPOINT}: "${ambientPrompt}"`);
        try {
          const ambRes = await falSubmitCompat(AMBIENT_ENDPOINT, { video_url: tempUrl, prompt: ambientPrompt });
          if (!ambRes.ok) throw new Error(`ambient submit failed: ${ambRes.status}`);
          const ambJson = await ambRes.json();
          if (!ambJson.request_id) throw new Error('ambient job returned no request id');

          await supabase
            .from('generations')
            .update({
              metadata: {
                ...(genRow?.metadata || {}),
                ambient_request_id: ambJson.request_id,
                ambient_pending: false,
                silent_video_url: tempUrl
              },
              updated_at: new Date().toISOString()
            })
            .eq('fal_request_id', requestId);

          return NextResponse.json({
            status: 'IN_QUEUE',
            progressMessage: 'กำลังใส่เสียงบรรยากาศให้คลิป...',
            progressPercent: 90
          });
        } catch (ambErr: any) {
          // Sound is a bonus, not the deliverable: keep the silent clip rather than failing
          console.error('[Ambient] skipped:', ambErr?.message || ambErr);
        }
      }

      // Check if we need to run Lip-Sync Post-Processing
      if (!lipsyncRequestId && !isAmbientPhase && !isNoSpeech && !isNarration && !isAvatar && audioUrl) {
        console.log(`⏳ [Lip-Sync Post-Processing] Submitting base video: ${tempUrl} with audio: ${audioUrl} to fal-ai/sync-lipsync/v3...`);
        try {
          const syncResponse = await falSubmitCompat(LIPSYNC_ENDPOINT, {
              video_url: tempUrl,
              audio_url: audioUrl
            });

          if (!syncResponse.ok) {
            const syncError = await syncResponse.text();
            console.error(`❌ [Lip-Sync Submit Error] Status: ${syncResponse.status}, Error:`, syncError);
            throw new Error('ส่งคำสั่ง Lip-Sync ไปยัง Fal.ai ไม่สำเร็จ');
          }

          const syncResult = await syncResponse.json();
          const nextRequestId = syncResult.request_id;
          console.log(`✅ [Lip-Sync Submit] Success! Request ID: ${nextRequestId}`);

          if (!nextRequestId) {
            throw new Error('ระบบ Lip-Sync ไม่ได้ส่งคืน Request ID');
          }

          // Update DB metadata with lipsync_request_id and base_video_url
          const updatedMetadata = {
            ...(genRow?.metadata || {}),
            lipsync_request_id: nextRequestId,
            base_video_url: tempUrl
          };

          await supabase
            .from('generations')
            .update({
              metadata: updatedMetadata,
              updated_at: new Date().toISOString()
            })
            .eq('fal_request_id', requestId);

          return NextResponse.json({
            status: 'IN_QUEUE',
            progressMessage: 'กำลังเริ่มซิงก์ปากกับเสียงพากย์...',
            progressPercent: 90
          });
        } catch (syncErr: any) {
          console.error('❌ [Lip-Sync Submit Exception] Failed to run lipsync:', syncErr);
        }
      }

      const isImage = videoPath.endsWith('.png') || videoPath.endsWith('.jpg') || videoPath.endsWith('.jpeg');
      const contentType = isImage ? (videoPath.endsWith('.png') ? 'image/png' : 'image/jpeg') : 'video/mp4';
      const fileTypeLabel = isImage ? 'รูปภาพ' : 'วิดีโอ';
      console.log(`⏳ [KRUTH Status] AI ทำงานเสร็จแล้ว! กำลังโหลด${fileTypeLabel}มาเก็บที่ ${finalStorageProvider}...`);

      const videoRes = await fetch(tempUrl);
      let videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // VFX background replacement: the matte engine's person clip becomes the product
      // only once it sits on the new background; the O3 engine's clip only needs its grade.
      const vfxMeta = genRow?.metadata?.mode === 'vfx-background' ? genRow.metadata : null;
      if (vfxMeta && !isImage) {
        if (vfxMeta.vfx_engine === 'matte') {
          if (!matteAlphaUrl) throw new Error('ผลตัดคนไม่มีเลเยอร์ alpha กลับมา — ประกอบฉากไม่ได้');
          console.log('[VFX] compositing person onto new background');
          videoBuffer = await compositeBackground(
            videoBuffer, matteAlphaUrl, vfxMeta.vfx_background_url, vfxMeta.vfx_footage_url,
            Number(vfxMeta.vfx_width) || 0, Number(vfxMeta.vfx_height) || 0, vfxMeta.vfx_grade || 'none'
          );
        } else if (vfxMeta.vfx_grade && vfxMeta.vfx_grade !== 'none') {
          videoBuffer = await gradeVideo(videoBuffer, vfxMeta.vfx_grade);
        }
      }

      // Kling's lip-sync draws the mouth a steady ~0.25s behind the sound — measured by
      // frame-stepping around the speech onset (audio at 1.14s, lips parting at 1.3–1.4s)
      // and confirmed at the tail. A constant lag has a constant cure: hold the audio back
      // by the same amount at mux time. Video stream is copied untouched; only here, on
      // the finished lip-synced clip, never for other phases.
      if (isLipsyncPhase && !isImage) {
        videoBuffer = await delayAudioTrack(videoBuffer, 0.25);
      }

      // Mode A: the narration was never lip-synced — it is laid over the finished scene
      // here, video stream untouched. The padded audio already carries its 1s of lead-in.
      if (isNarration && !isAmbientPhase && !isImage && audioUrl) {
        videoBuffer = await muxNarration(videoBuffer, audioUrl);
      }

      // Speech + ambience: this ambient round scored the FINISHED speech clip, so the
      // room tone goes underneath that clip's own voice track — never in place of it.
      const finalSpeechUrl = genRow?.metadata?.final_speech_url;
      if (isAmbientPhase && genRow?.metadata?.ambient_mix_speech === true && finalSpeechUrl && !isImage) {
        try {
          const speechRes = await fetch(finalSpeechUrl);
          if (!speechRes.ok) throw new Error('speech clip fetch ' + speechRes.status);
          const speechBuf = Buffer.from(await speechRes.arrayBuffer());
          videoBuffer = await mixAmbientUnder(speechBuf, videoBuffer);
        } catch (mixErr) {
          // Shipping the mmaudio output as-is would REPLACE the voice — retry instead
          console.warn('[Ambient Mix] speech clip unreachable, retrying next poll:', mixErr);
          return NextResponse.json({ status: 'WAITING', progressPercent: 92, progressMessage: '🎵 กำลังผสมเสียงบรรยากาศ...' });
        }
      }

      let publicUrl = '';
      if (finalStorageProvider === 'firebase') {
        publicUrl = await uploadToFirebaseStorage(videoBuffer, videoPath, contentType);
      } else {
        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('kruth-ai-assets')
          .upload(videoPath, videoBuffer, {
            contentType,
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`อัปโหลด${fileTypeLabel}ขึ้น Supabase Storage ไม่สำเร็จ: ${uploadError.message}`);
        }

        // Get Public URL
        const { data: { publicUrl: supabaseUrl } } = supabase.storage
          .from('kruth-ai-assets')
          .getPublicUrl(videoPath);
        publicUrl = supabaseUrl;
      }

      console.log(`✅ [KRUTH Status] บันทึกวิดีโอลง ${finalStorageProvider} สำเร็จ! URL: ${publicUrl}`);

      // Speech clip finished and ambience was requested: score THIS clip, then a later
      // round mixes that score underneath the voice. The clip already sits in storage, so
      // if anything below fails the user still has their video.
      if (ambientPending && !isAmbientPhase && !isNoSpeech && !isImage && (isLipsyncPhase || isNarration || (genRow?.metadata?.avatar_mode === true))) {
        try {
          const ambientPrompt = genRow?.metadata?.ambient_prompt || 'natural ambience matching the scene';
          console.log(`⏳ [Ambient/Speech] Scoring finished speech clip: "${ambientPrompt}"`);
          const secs = Math.min(45, Math.max(4, Math.ceil((genRow?.metadata?.duration_estimate || 10) + 1)));
          const ambRes = await falSubmitCompat(AMBIENT_TTA_ENDPOINT, { prompt: ambientPrompt, seconds_total: secs });
          if (!ambRes.ok) throw new Error(`ambient submit failed: ${ambRes.status}`);
          const ambJson = await ambRes.json();
          if (!ambJson.request_id) throw new Error('ambient job returned no request id');
          await supabase
            .from('generations')
            .update({
              metadata: {
                ...(genRow?.metadata || {}),
                ambient_request_id: ambJson.request_id,
                ambient_endpoint: AMBIENT_TTA_ENDPOINT,
                ambient_pending: false,
                ambient_mix_speech: true,
                final_speech_url: publicUrl
              }
            })
            .eq('fal_request_id', requestId);
          return NextResponse.json({ status: 'IN_QUEUE', progressPercent: 90, progressMessage: '🎵 กำลังเติมเสียงบรรยากาศ...' });
        } catch (ambErr: any) {
          console.error('[Ambient/Speech] skipped:', ambErr?.message || ambErr);
          // fall through — the clip completes without ambience
        }
      }

      // Update generation status in Supabase
      const { error: dbError } = await supabase
        .from('generations')
        .update({
          status: 'completed',
          video_url: publicUrl,
          updated_at: new Date().toISOString()
        })
        .eq('fal_request_id', requestId);

      if (dbError) {
        console.error('Failed to update generation row in Supabase:', dbError);
      }

      return NextResponse.json({ 
        status: 'COMPLETED', 
        videoUrl: publicUrl,
        progressPercent: 100,
        progressMessage: '✅ เสร็จสมบูรณ์!'
      });

    } else if (currentStatus === 'FAILED') {
      console.error(`❌ [KRUTH Status] AI แจ้งเตือนข้อผิดพลาด:`, statusData.error);

      // Update generation status to failed in Supabase
      await supabase
        .from('generations')
        .update({
          status: 'failed',
          error_message: statusData.error || 'AI generation failed',
          updated_at: new Date().toISOString()
        })
        .eq('fal_request_id', requestId);

      return NextResponse.json({ 
        status: 'FAILED', 
        error: statusData.error || 'AI generation failed',
        progressPercent: undefined,
        progressMessage: '❌ ล้มเหลว'
      });
    }

    // In progress or queue: parse progress
    let progressMessage = 'กำลังประมวลผล...';
    let progressPercent = 10;

    if (currentStatus === 'IN_QUEUE') {
      const queuePos = statusData.queue_position ?? 1;
      progressMessage = isLipsyncPhase
        ? `กำลังซิงก์ปากกับเสียงพากย์ (คิวที่ ${queuePos})`
        : `อยู่ในคิวประมวลผล (คิวที่ ${queuePos})`;
      progressPercent = isLipsyncPhase
        ? 90
        : Math.max(5, Math.min(15, 15 - queuePos));
    } else if (currentStatus === 'IN_PROGRESS') {
      progressMessage = isLipsyncPhase
        ? 'กำลังประมวลผลซิงก์ปากกับเสียงพากย์...'
        : 'กำลังสร้างสรรค์วิดีโอ...';
      progressPercent = isLipsyncPhase ? 95 : 30;

      let logs = statusData.logs;

      // If no logs, fetch from detail endpoint as fallback
      if (!isLipsyncPhase && (!logs || !Array.isArray(logs) || logs.length === 0)) {
        try {
          const detailUrl = statusData.response_url || `https://queue.fal.run/${queueNamespace}/requests/${requestId}`;
          const dr = await falResult(modelEndpoint, requestId, detailUrl);
        const detailResponse = { ok: dr.ok, status: dr.httpStatus, json: async () => dr.data, text: async () => dr.text } as any;
          if (detailResponse.ok) {
            const detailData = await detailResponse.json();
            if (detailData.logs && Array.isArray(detailData.logs)) {
              logs = detailData.logs;
            }
          }
        } catch (e) {
          console.warn('Failed to fetch details for logs:', e);
        }
      }

      if (!isLipsyncPhase && logs && Array.isArray(logs) && logs.length > 0) {
        for (let i = logs.length - 1; i >= 0; i--) {
          const logText = logs[i].message || '';
          const pctMatch = logText.match(/(\d+)%/);
          if (pctMatch) {
            const pct = parseInt(pctMatch[1], 10);
            progressPercent = Math.min(85, 20 + Math.floor(pct * 0.70));
            progressMessage = `กำลังประมวลผล: ${pct}%`;
            break;
          }
          const stepMatch = logText.match(/(\d+)\s*\/\s*(\d+)/);
          if (stepMatch) {
            const currentStep = parseInt(stepMatch[1], 10);
            const totalSteps = parseInt(stepMatch[2], 10);
            if (totalSteps > 0) {
              const pct = Math.floor((currentStep / totalSteps) * 100);
              progressPercent = Math.min(85, 20 + Math.floor(pct * 0.70));
              progressMessage = `กำลังประมวลผลขั้นตอน: ${currentStep}/${totalSteps} (${pct}%)`;
              break;
            }
          }
        }
      }
    }

    return NextResponse.json({ 
      status: currentStatus,
      progressMessage,
      progressPercent
    });

  } catch (error: any) {
    console.error('\n❌ [KRUTH Status Error]:', error.message);
    return NextResponse.json({ status: 'ERROR', error: error.message }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

const LIPSYNC_ENDPOINT = 'fal-ai/sync-lipsync/v3';
const AMBIENT_ENDPOINT = 'fal-ai/mmaudio-v2';

/**
 * Fal's queue lives on the application id, never on the sub-path a job was submitted to:
 * submitting `fal-ai/flux/schnell` means polling `fal-ai/flux/requests/{id}/status`, and
 * hitting the sub-path answers 405 — which this route used to report as "still waiting",
 * so the job appeared to hang forever. An application id is always the first two segments
 * (`owner/app`); everything after it is a variant. Verified against kling-video, flux,
 * bytedance, veo3, sora-2, image-editing, sync-lipsync and xai/grok-imagine-video.
 */
function baseAppId(endpoint: string): string {
  const parts = (endpoint || '').split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(0, 2).join('/');
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
    const isLipsyncPhase = !!lipsyncRequestId;
    const ambientRequestId = genRow?.metadata?.ambient_request_id;
    const isAmbientPhase = !isLipsyncPhase && !!ambientRequestId;

    const apiProvider = genRow?.metadata?.api_provider || 'fal';

    let statusData: any = null;
    let currentStatus = '';

    if (isAmbientPhase) {
      // Scoring a silent clip runs as its own queued job, exactly like lip-sync
      const checkResponse = await fetch(`https://queue.fal.run/${baseAppId(AMBIENT_ENDPOINT)}/requests/${ambientRequestId}/status`, {
        headers: { 'Authorization': `Key ${falKey}`, 'Accept': 'application/json' },
        cache: 'no-store'
      });
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
      const checkResponse = await fetch(`https://queue.fal.run/${baseAppId(LIPSYNC_ENDPOINT)}/requests/${lipsyncRequestId}/status`, {
        headers: {
          'Authorization': `Key ${falKey}`,
          'Accept': 'application/json'
        },
        cache: 'no-store'
      });

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
      const checkResponse = await fetch(checkUrl, {
        headers: {
          'Authorization': `Key ${falKey}`,
          'Accept': 'application/json'
        },
        cache: 'no-store'
      });

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

      if (apiProvider === 'siliconflow' && !isLipsyncPhase) {
        tempUrl = statusData.results?.videos?.[0]?.url;
      } else {
        const detailUrl = statusData.response_url || (isAmbientPhase
          ? `https://queue.fal.run/${baseAppId(AMBIENT_ENDPOINT)}/requests/${ambientRequestId}`
          : isLipsyncPhase
          ? `https://queue.fal.run/${baseAppId(LIPSYNC_ENDPOINT)}/requests/${lipsyncRequestId}`
          : `https://queue.fal.run/${queueNamespace}/requests/${requestId}`);

        const detailResponse = await fetch(detailUrl, {
          headers: {
            'Authorization': `Key ${falKey}`,
            'Accept': 'application/json'
          },
          cache: 'no-store'
        });
        
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

            return NextResponse.json({
              status: 'FAILED',
              error: `ระบบ AI ปฏิเสธคำสั่งนี้ — ${why}`,
              progressMessage: '❌ ล้มเหลว'
            });
          }

          throw new Error(`ไม่สามารถดึงผลลัพธ์จาก Fal.ai ได้ (status: ${detailResponse.status})`);
        }

        const detailData = await detailResponse.json();
        tempUrl = detailData.video?.url || detailData.output?.video?.url || detailData.images?.[0]?.url || detailData.image?.url;
      }

      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      let finalStorageProvider = storageProvider;
      if (!finalStorageProvider) {
        finalStorageProvider = genRow?.metadata?.storage_provider || 'supabase';
      }

      const audioUrl = genRow?.audio_prompt;
      const isNoSpeech = genRow?.metadata?.is_no_speech === true;

      // A silent clip from an engine that can't score itself gets a soundtrack now, as its
      // own queued job — the previous attempt at this ran inline and timed out, so it never
      // blocks this request.
      const ambientPending = genRow?.metadata?.ambient_pending === true;
      if (!isLipsyncPhase && !isAmbientPhase && ambientPending && isNoSpeech && tempUrl) {
        const ambientPrompt = genRow?.metadata?.ambient_prompt || 'natural ambience matching the scene';
        console.log(`⏳ [Ambient] Scoring silent clip via ${AMBIENT_ENDPOINT}: "${ambientPrompt}"`);
        try {
          const ambRes = await fetch(`https://queue.fal.run/${AMBIENT_ENDPOINT}`, {
            method: 'POST',
            headers: {
              'Authorization': `Key ${falKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({ video_url: tempUrl, prompt: ambientPrompt })
          });
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
      if (!isLipsyncPhase && !isNoSpeech && audioUrl) {
        console.log(`⏳ [Lip-Sync Post-Processing] Submitting base video: ${tempUrl} with audio: ${audioUrl} to fal-ai/sync-lipsync/v3...`);
        try {
          const syncResponse = await fetch(`https://queue.fal.run/${LIPSYNC_ENDPOINT}`, {
            method: 'POST',
            headers: {
              'Authorization': `Key ${falKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              video_url: tempUrl,
              audio_url: audioUrl,
              sync_mode: 'cut_off'
            })
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
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

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
          const detailResponse = await fetch(detailUrl, {
            headers: {
              'Authorization': `Key ${falKey}`,
              'Accept': 'application/json'
            },
            cache: 'no-store'
          });
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
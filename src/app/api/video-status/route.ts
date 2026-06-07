import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

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
    const { requestId, videoPath, modelType, storageProvider } = await req.json();
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY || '';

    if (!requestId || !videoPath) {
      return NextResponse.json({ status: 'ERROR', error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const isCinema = modelType === 'cinema';
    const isMotionControl = modelType === 'motion-control';
    const modelEndpoint = isCinema
      ? 'fal-ai/wan-i2v'
      : (isMotionControl ? 'fal-ai/kling-video/v2.6/standard/motion-control' : 'fal-ai/kling-video/v2.5/turbo/image-to-video');

    // Fal.ai queue parent namespace is always the first two segments of the model path
    const queueNamespace = modelEndpoint.split('/').slice(0, 2).join('/');

    // 1. Fetch official queue status endpoint
    const checkResponse = await fetch(`https://queue.fal.run/${queueNamespace}/requests/${requestId}/status`, {
      headers: {
        'Authorization': `Key ${falKey}`,
        'Accept': 'application/json'
      },
      cache: 'no-store'
    });

    if (!checkResponse.ok) {
      console.error(`[KRUTH Status Fail] status: ${checkResponse.status}`);
      if (checkResponse.status === 401 || checkResponse.status === 403) {
        return NextResponse.json({ 
          status: 'ERROR', 
          error: 'สิทธิ์การใช้งาน Fal.ai (FAL_KEY) ไม่ถูกต้อง หรือหมดอายุ' 
        }, { status: checkResponse.status });
      }
      return NextResponse.json({ status: 'WAITING' });
    }

    const statusData = await checkResponse.json();
    const currentStatus = statusData.status;

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (currentStatus === 'COMPLETED') {
      const detailResponse = await fetch(`https://queue.fal.run/${queueNamespace}/requests/${requestId}`, {
        headers: {
          'Authorization': `Key ${falKey}`,
          'Accept': 'application/json'
        },
        cache: 'no-store'
      });
      
      if (!detailResponse.ok) {
        const errorText = await detailResponse.text();
        console.error(`[Fal.ai Queue Detail Error] Status: ${detailResponse.status}, Response:`, errorText);
        throw new Error(`ไม่สามารถดึงผลลัพธ์จาก Fal.ai ได้ (status: ${detailResponse.status})`);
      }

      const detailData = await detailResponse.json();
      const tempUrl = detailData.video?.url || detailData.output?.video?.url || detailData.images?.[0]?.url;
      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      let finalStorageProvider = storageProvider;
      let genRow: any = null;

      try {
        const { data: dbGenRow } = await supabase
          .from('generations')
          .select('metadata, audio_prompt')
          .eq('fal_request_id', requestId)
          .single();
        genRow = dbGenRow;
      } catch (dbErr) {
        console.warn('[Supabase DB Read] Could not find or read generation metadata:', dbErr);
      }

      if (!finalStorageProvider) {
        finalStorageProvider = genRow?.metadata?.storage_provider || 'supabase';
      }

      const modelName = genRow?.metadata?.model_name || '';
      const audioUrl = genRow?.audio_prompt;
      
      let finalVideoUrl = tempUrl;
      const isKling = modelName ? modelName.toLowerCase().includes('kling') : (modelType === 'fast');

      if (isKling && audioUrl) {
        console.log(`⏳ [FFmpeg Merge] Kling silent video: ${tempUrl} with audio: ${audioUrl}...`);
        try {
          const mergeResponse = await fetch('https://fal.run/fal-ai/ffmpeg-api/merge-audio-video', {
            method: 'POST',
            headers: {
              'Authorization': `Key ${falKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              video_url: tempUrl,
              audio_url: audioUrl
            })
          });

          if (mergeResponse.ok) {
            const mergeResult = await mergeResponse.json();
            const mergedUrl = mergeResult.video?.url || mergeResult.output?.video?.url;
            if (mergedUrl) {
              finalVideoUrl = mergedUrl;
              console.log(`✅ [FFmpeg Merge] Successful! Combined Video URL: ${finalVideoUrl}`);
            } else {
              console.warn('[FFmpeg Merge] Merge response was missing video URL:', mergeResult);
            }
          } else {
            const mergeError = await mergeResponse.text();
            console.error(`❌ [FFmpeg Merge Error] Status: ${mergeResponse.status}, Error:`, mergeError);
          }
        } catch (mergeErr) {
          console.error('❌ [FFmpeg Merge Exception] Failed to run merge:', mergeErr);
        }
      }

      console.log(`⏳ [KRUTH Status] AI ทำงานเสร็จแล้ว! กำลังโหลดวิดีโอมาเก็บที่ ${finalStorageProvider}...`);

      const videoRes = await fetch(finalVideoUrl);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      let publicUrl = '';
      if (finalStorageProvider === 'firebase') {
        publicUrl = await uploadToFirebaseStorage(videoBuffer, videoPath, 'video/mp4');
      } else {
        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('kruth-ai-assets')
          .upload(videoPath, videoBuffer, {
            contentType: 'video/mp4',
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`อัปโหลดวิดีโอขึ้น Supabase Storage ไม่สำเร็จ: ${uploadError.message}`);
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
      progressMessage = `อยู่ในคิวประมวลผล (คิวที่ ${queuePos})`;
      progressPercent = Math.max(5, Math.min(15, 15 - queuePos));
    } else if (currentStatus === 'IN_PROGRESS') {
      progressMessage = 'กำลังสร้างสรรค์วิดีโอ...';
      progressPercent = 30;

      let logs = statusData.logs;

      // ถ้าไม่มี logs ใน statusData ให้ลองดึงจาก detail endpoint เป็นทางเลือกสำรอง
      if (!logs || !Array.isArray(logs) || logs.length === 0) {
        try {
          const detailResponse = await fetch(`https://queue.fal.run/${queueNamespace}/requests/${requestId}`, {
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

      if (logs && Array.isArray(logs) && logs.length > 0) {
        for (let i = logs.length - 1; i >= 0; i--) {
          const logText = logs[i].message || '';
          const pctMatch = logText.match(/(\d+)%/);
          if (pctMatch) {
            const pct = parseInt(pctMatch[1], 10);
            progressPercent = Math.min(95, 20 + Math.floor(pct * 0.75));
            progressMessage = `กำลังประมวลผล: ${pct}%`;
            break;
          }
          const stepMatch = logText.match(/(\d+)\s*\/\s*(\d+)/);
          if (stepMatch) {
            const currentStep = parseInt(stepMatch[1], 10);
            const totalSteps = parseInt(stepMatch[2], 10);
            if (totalSteps > 0) {
              const pct = Math.floor((currentStep / totalSteps) * 100);
              progressPercent = Math.min(95, 20 + Math.floor(pct * 0.75));
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
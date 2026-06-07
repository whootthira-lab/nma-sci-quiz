import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function uploadToSupabaseStorage(
  buffer: Buffer,
  path: string,
  contentType: string
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error } = await supabase.storage
    .from('kruth-ai-assets')
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    console.error(`[Supabase Storage Error] Cannot upload: ${path}`, error);
    throw new Error('อัปโหลดไฟล์ขึ้น Supabase Storage ไม่สำเร็จ');
  }

  const { data: { publicUrl } } = supabase.storage
    .from('kruth-ai-assets')
    .getPublicUrl(path);

  return publicUrl;
}

async function generateTTS(text: string, voiceId: string): Promise<Buffer> {
  const botnoiToken = process.env.BOTNOI_TOKEN;
  if (!botnoiToken) throw new Error('ไม่พบ BOTNOI_TOKEN ในระบบ');

  const voiceMap: Record<string, string> = {
    'ava': '1',
    'jaidee': '2',
    'kacha': '3',
    'te': '4'
  };
  const speakerId = voiceMap[voiceId] || voiceId;

  console.log(`[Botnoi] Generating Thai TTS audio for speaker ID: ${speakerId}`);

  const botnoiResponse = await fetch('https://api-voice.botnoi.ai/api/service/generate_audio', {
    method: 'POST',
    headers: {
      'Botnoi-Token': botnoiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text,
      speaker: speakerId,
      volume: 1,
      speed: 1,
      type_media: 'mp3'
    }),
  });

  if (!botnoiResponse.ok) {
    let errorText = '';
    try {
      errorText = await botnoiResponse.text();
      const errorJson = JSON.parse(errorText);
      if (errorJson && errorJson.message) {
        throw new Error(`Botnoi TTS API failed: ${errorJson.message} (กรุณาเติมเครดิต Botnoi หรือติดต่อผู้ดูแลระบบ)`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Botnoi TTS API failed:')) {
        throw e;
      }
    }
    throw new Error(`Botnoi TTS API failed with status ${botnoiResponse.status}${errorText ? ` - ${errorText}` : ''}`);
  }

  const data = await botnoiResponse.json();

  if (!data.audio_url) {
    throw new Error('Botnoi did not return audio_url');
  }

  const audioFetch = await fetch(data.audio_url);
  if (!audioFetch.ok) {
    throw new Error('Failed to fetch audio file from Botnoi url');
  }

  const arrayBuffer = await audioFetch.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function getWanVideoParams(targetSeconds: number) {
  // Constraints:
  // num_frames must be between 81 and 100
  // frames_per_second must be between 5 and 24
  let bestFrames = 81;
  let bestFps = 16;
  let minDiff = Infinity;

  for (let frames = 81; frames <= 100; frames++) {
    for (let fps = 5; fps <= 24; fps++) {
      const duration = frames / fps;
      const diff = Math.abs(duration - targetSeconds);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrames = frames;
        bestFps = fps;
      }
    }
  }

  return { num_frames: bestFrames, frames_per_second: bestFps };
}

export async function POST(req: NextRequest) {
  try {
    console.log('\n==================================');
    console.log('[STEP 0] Triggering Asynchronous Video Generation');

    const formData = await req.formData();
    const imageFile = formData.get('image') as File;
    const videoFile = formData.get('video') as File;
    const motionAudioSource = formData.get('motion_audio_source') as string || 'video';
    const scriptText = formData.get('script_text') as string;
    const situationPrompt = formData.get('situation_prompt') as string;
    const voiceId = formData.get('voice_id') as string;
    const aspectRatio = (formData.get('aspect_ratio') as string) || '16:9';
    const userEmail = formData.get('user_email') as string;
    const userId = formData.get('user_id') as string;
    const modelType = formData.get('model_type') as string || 'fast';
    const storageProvider = formData.get('storage_provider') as string || 'supabase';
    const ttsProvider = formData.get('tts_provider') as string || 'botnoi';
    const selectedDuration = parseInt(formData.get('duration') as string || '8', 10);
    const safetyFilterDisabled = formData.get('safety_filter_disabled') === 'true';

    const isMotionControl = modelType === 'motion-control';

    if (isMotionControl) {
      if (!imageFile || !videoFile || !userEmail) {
        return NextResponse.json(
          { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกรูปภาพและวิดีโอต้นแบบให้ครบ' },
          { status: 400 }
        );
      }
      if (motionAudioSource === 'botnoi' && !scriptText) {
        return NextResponse.json(
          { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกบทพากย์สำหรับ Botnoi' },
          { status: 400 }
        );
      }
    } else {
      if (!imageFile || !scriptText || !userEmail) {
        return NextResponse.json(
          { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกรูปภาพและข้อความให้ครบ' },
          { status: 400 }
        );
      }
    }

    const falKey = process.env.FAL_KEY;
    if (!falKey) throw new Error('ไม่พบ FAL_KEY ในระบบ');

    const timestamp = Date.now();

    // 1. Upload reference image
    console.log('[STEP 1] Uploading reference image to Supabase...');
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const imagePath = `references/${userEmail}/${timestamp}_ref.${imageFile.type.split('/')[1] || 'png'}`;
    const imageUrl = await uploadToSupabaseStorage(imageBuffer, imagePath, imageFile.type);
    console.log('[STEP 1] Image uploaded:', imageUrl);

    // 1.5. Upload reference video for Motion Control
    let videoUrl = '';
    let refVideoPath = '';
    if (isMotionControl && videoFile) {
      console.log('[STEP 1.5] Uploading reference video to Supabase...');
      const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
      refVideoPath = `references/${userEmail}/${timestamp}_ref_video.${videoFile.type.split('/')[1] || 'mp4'}`;
      videoUrl = await uploadToSupabaseStorage(videoBuffer, refVideoPath, videoFile.type);
      console.log('[STEP 1.5] Reference video uploaded:', videoUrl);
    }

    // 2. Generate Thai TTS audio (only if needed)
    let audioUrl = '';
    let audioPath = '';
    const needTTS = !isMotionControl || (isMotionControl && motionAudioSource === 'botnoi');
    
    if (needTTS && scriptText) {
      console.log(`[STEP 2] Generating Botnoi TTS audio using voice ID: ${voiceId}...`);
      const audioBuffer = await generateTTS(scriptText, voiceId);
      audioPath = `audio/${userEmail}/${timestamp}_tts.mp3`;
      audioUrl = await uploadToSupabaseStorage(audioBuffer, audioPath, 'audio/mpeg');
      console.log('[STEP 2] TTS audio uploaded:', audioUrl);
    }

    // 3. Configure endpoint
    const isCinema = modelType === 'cinema';
    const isMotionControlModel = modelType === 'motion-control';
    const isGrok = modelType === 'grok-video';
    const modelEndpoint = isCinema
      ? 'fal-ai/wan-i2v'
      : (isMotionControlModel 
          ? 'fal-ai/kling-video/v2.6/standard/motion-control' 
          : (isGrok ? 'xai/grok-imagine-video/v1.5/image-to-video' : 'fal-ai/kling-video/v2.5/turbo/image-to-video')
        );

    // 4. Build Fal.ai request body
    const combinedPrompt = situationPrompt
      ? `${situationPrompt}, talking, lip sync`
      : 'A person talking naturally, gentle expressions, professional setting';

    let requestBody: Record<string, any>;
    if (isCinema) {
      const wanParams = getWanVideoParams(selectedDuration);
      console.log(`[Wan 2.5 Cinema Params] Selected duration: ${selectedDuration}s => Calculated frames: ${wanParams.num_frames}, FPS: ${wanParams.frames_per_second}`);
      
      requestBody = {
        image_url: imageUrl,
        audio_url: audioUrl,
        prompt: combinedPrompt,
        negative_prompt: 'blurry, distorted, low quality, static, frozen',
        num_frames: wanParams.num_frames,
        frames_per_second: wanParams.frames_per_second,
        aspect_ratio: aspectRatio === '16:9' ? '16:9' : aspectRatio === '9:16' ? '9:16' : '1:1',
        resolution: '720p',
        num_inference_steps: 30,
        guide_scale: 5.0,
        shift: 3.0,
      };
    } else if (isMotionControlModel) {
      requestBody = {
        image_url: imageUrl,
        video_url: videoUrl,
        character_orientation: 'video',
        keep_original_sound: motionAudioSource === 'video',
      };
      if (situationPrompt) {
        requestBody.prompt = situationPrompt;
      }
    } else if (isGrok) {
      requestBody = {
        image_url: imageUrl,
        prompt: combinedPrompt,
        aspect_ratio: aspectRatio === '16:9' ? '16:9' : aspectRatio === '9:16' ? '9:16' : '1:1',
        duration: selectedDuration,
        enable_safety_checker: !safetyFilterDisabled,
        enable_safety_checks: !safetyFilterDisabled,
      };
    } else {
      requestBody = {
        image_url: imageUrl,
        prompt: combinedPrompt,
        aspect_ratio: aspectRatio === '16:9' ? '16:9' : aspectRatio === '9:16' ? '9:16' : '1:1',
        duration: selectedDuration <= 5 ? 5 : 10,
      };
    }

    // 5. Submit job to Fal.ai queue
    console.log(`[STEP 3] Submitting queue request to Fal.ai (${modelEndpoint})...`);
    console.log('[Fal.ai Request Payload]:', JSON.stringify(requestBody, null, 2));
    const submitResponse = await fetch(`https://queue.fal.run/${modelEndpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!submitResponse.ok) {
      const errText = await submitResponse.text();
      console.error(`[Fal.ai Submit Error]`, errText);
      throw new Error('ส่งคำสั่งสร้างวิดีโอไปยัง Fal.ai ไม่สำเร็จ');
    }

    const submitResult = await submitResponse.json();
    const requestId = submitResult.request_id;
    console.log(`[Fal.ai] Job submitted. Request ID: ${requestId}`);

    if (!requestId) {
      throw new Error('ระบบ AI ไม่ได้ส่งคืน Request ID');
    }

    // 6. Save initial pending/processing generation state to Supabase
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let finalUserId = userId;
    
    // Fallback search in auth users if userId is not provided
    if (!finalUserId && userEmail) {
      try {
        const { data: authUsers } = await supabase.auth.admin.listUsers();
        const foundUser = authUsers?.users?.find(u => u.email?.toLowerCase() === userEmail.toLowerCase());
        if (foundUser) {
          finalUserId = foundUser.id;
        }
      } catch (e) {
        console.warn('Error querying auth users:', e);
      }
    }

    if (finalUserId) {
      // Ensure the profile row exists in the profiles table to avoid foreign key violations
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', finalUserId)
          .single();
        
        if (!profile) {
          console.log(`[profiles] Creating missing profile row for user: ${finalUserId} (${userEmail})`);
          const { error: profileInsertError } = await supabase
            .from('profiles')
            .insert({
              id: finalUserId,
              email: userEmail,
              role: userEmail === 'whootthira@gmail.com' ? 'admin' : 'user'
            });
          if (profileInsertError) {
            console.error('[profiles] Failed to insert profile row:', profileInsertError);
          }
        }
      } catch (e) {
        console.error('[profiles] Error checking/inserting profile row:', e);
      }
    }

    const videoPath = `videos/${userEmail}/${timestamp}_output.mp4`;

    if (finalUserId) {
      console.log(`[STEP 4] Saving initial generation record for user: ${finalUserId}`);
      const { error: dbError } = await supabase
        .from('generations')
        .insert({
          user_id: finalUserId,
          prompt: isMotionControl && situationPrompt ? situationPrompt : combinedPrompt,
          audio_prompt: audioUrl || null,
          source_image_url: imageUrl,
          status: 'processing',
          fal_request_id: requestId,
          metadata: {
            mode: isMotionControl ? 'motion-control' : 'text-to-video',
            script_text: isMotionControl && motionAudioSource === 'video' ? '' : scriptText,
            situation_prompt: situationPrompt || '',
            model_name: isMotionControl 
              ? 'kling-2.6-motion-control' 
              : (isCinema 
                  ? 'wan-2.5-cinema' 
                  : (modelType === 'grok-video' ? 'grok-1.5-imagine-video' : 'kling-2.5-turbo')
                ),
            voice_id: isMotionControl && motionAudioSource === 'video' ? '' : voiceId,
            tts_provider: ttsProvider,
            storage_provider: storageProvider,
            aspect_ratio: isMotionControl ? 'auto' : aspectRatio,
            duration_estimate: selectedDuration,
            storage_path: videoPath,
            image_path: imagePath,
            audio_path: audioPath || null,
            driving_path: refVideoPath || null
          }
        });

      if (dbError) {
        console.error('Error inserting generation row to Supabase:', dbError);
      }
    } else {
      console.warn('Skipped DB insert: user profile UUID could not be resolved.');
    }

    console.log('🎉 [SUCCESS] Job queued successfully!');
    console.log('==================================\n');

    return NextResponse.json({
      success: true,
      requestId,
      videoPath,
    });
  } catch (error: any) {
    console.error('\n❌ [ERROR] เกิดข้อผิดพลาด:', error.message || error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดภายในระบบ' },
      { status: 500 }
    );
  }
}
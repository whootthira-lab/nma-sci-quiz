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
    throw new Error(`Botnoi TTS API failed with status ${botnoiResponse.status}`);
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

async function generateAzureTTS(text: string, voiceId: string): Promise<Buffer> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION || 'southeastasia';
  if (!key) throw new Error('ไม่พบ AZURE_SPEECH_KEY ในระบบ');

  console.log(`[Azure TTS] Generating Thai TTS audio for voice ID: ${voiceId}`);

  const ssml = `<speak version='1.0' xml:lang='th-TH'><voice name='${voiceId}'>${text}</voice></speak>`;

  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      'User-Agent': 'KruthAIVideoPlatform',
    },
    body: ssml,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure TTS API failed: ${response.status} - ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(req: NextRequest) {
  try {
    console.log('\n==================================');
    console.log('[STEP 0] Triggering Asynchronous Video Generation');

    const formData = await req.formData();
    const imageFile = formData.get('image') as File;
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

    if (!imageFile || !scriptText || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกรูปภาพและข้อความให้ครบ' },
        { status: 400 }
      );
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

    // 2. Generate Thai TTS audio
    let audioBuffer: Buffer;
    if (ttsProvider === 'azure') {
      console.log(`[STEP 2] Generating Azure TTS audio using voice ID: ${voiceId}...`);
      audioBuffer = await generateAzureTTS(scriptText, voiceId);
    } else {
      console.log(`[STEP 2] Generating Botnoi TTS audio using voice ID: ${voiceId}...`);
      audioBuffer = await generateTTS(scriptText, voiceId);
    }
    const audioPath = `audio/${userEmail}/${timestamp}_tts.mp3`;
    const audioUrl = await uploadToSupabaseStorage(audioBuffer, audioPath, 'audio/mpeg');
    console.log('[STEP 2] TTS audio uploaded:', audioUrl);

    // 3. Estimate duration and configure dimensions
    const dimensions: Record<string, { width: number; height: number }> = {
      '1:1': { width: 512, height: 512 },
      '16:9': { width: 832, height: 480 },
      '9:16': { width: 480, height: 832 },
    };
    const dim = dimensions[aspectRatio] || dimensions['16:9'];

    const isCinema = modelType === 'cinema';
    const modelEndpoint = isCinema
      ? 'fal-ai/wan/image-to-video'
      : 'fal-ai/kling-video/v2.5/turbo/image-to-video';

    // 4. Build Fal.ai request body
    const combinedPrompt = situationPrompt
      ? `${situationPrompt}, talking, lip sync`
      : 'A person talking naturally, gentle expressions, professional setting';

    let requestBody: Record<string, any>;
    if (isCinema) {
      requestBody = {
        image_url: imageUrl,
        prompt: combinedPrompt,
        negative_prompt: 'blurry, distorted, low quality, static, frozen',
        num_frames: Math.min(selectedDuration * 8, 240),
        width: dim.width,
        height: dim.height,
        num_inference_steps: 30,
        guidance_scale: 5.0,
        flow_shift: 3.0,
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
    if (!finalUserId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', userEmail)
        .single();
      finalUserId = profile?.id || '';
    }

    const videoPath = `videos/${userEmail}/${timestamp}_output.mp4`;

    if (finalUserId) {
      console.log(`[STEP 4] Saving initial generation record for user: ${finalUserId}`);
      const { error: dbError } = await supabase
        .from('generations')
        .insert({
          user_id: finalUserId,
          prompt: combinedPrompt,
          audio_prompt: audioUrl,
          source_image_url: imageUrl,
          status: 'processing',
          fal_request_id: requestId,
          metadata: {
            mode: 'text-to-video',
            script_text: scriptText,
            situation_prompt: situationPrompt || '',
            model_name: isCinema ? 'wan-2.5-cinema' : 'kling-2.5-turbo',
            voice_id: voiceId,
            tts_provider: ttsProvider,
            storage_provider: storageProvider,
            aspect_ratio: aspectRatio,
            duration_estimate: selectedDuration,
            storage_path: videoPath,
            image_path: imagePath,
            audio_path: audioPath
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
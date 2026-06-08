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

async function generateTTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const botnoiToken = process.env.BOTNOI_TOKEN;
  if (!botnoiToken) throw new Error('ไม่พบ BOTNOI_TOKEN ในระบบ');

  const voiceMap: Record<string, string> = {
    'ava': '1',
    'jaidee': '2',
    'kacha': '3',
    'te': '4'
  };
  const speakerId = voiceMap[voiceId] || voiceId;

  console.log(`[Botnoi] Generating Thai TTS audio for speaker ID: ${speakerId} with speed factor: ${speedFactor}`);

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
      speed: speedFactor,
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

async function generateGoogleTTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  if (!apiKey) throw new Error('ไม่พบ GOOGLE_API_KEY ในระบบ สำหรับการใช้งาน Google TTS');

  console.log(`[Google TTS] Generating Thai TTS audio for voice ID: ${voiceId} with speed factor: ${speedFactor}`);

  const googleResponse = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { text: text },
      voice: {
        languageCode: 'th-TH',
        name: voiceId,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: speedFactor,
      },
    }),
  });

  if (!googleResponse.ok) {
    const errText = await googleResponse.text();
    console.error('[Google TTS API Error]', errText);
    throw new Error(`Google Cloud TTS API failed with status ${googleResponse.status}: ${errText}`);
  }

  const data = await googleResponse.json();

  if (!data.audioContent) {
    throw new Error('Google Cloud TTS did not return audioContent');
  }

  return Buffer.from(data.audioContent, 'base64');
}

async function generateOpenAITTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) throw new Error('ไม่พบ OPENAI_API_KEY ในระบบ สำหรับการใช้งาน OpenAI TTS');

  console.log(`[OpenAI TTS] Generating Thai TTS audio for voice ID: ${voiceId} with speed factor: ${speedFactor}`);

  const openAIResponse = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voiceId,
      response_format: 'mp3',
      speed: speedFactor,
    }),
  });

  if (!openAIResponse.ok) {
    const errText = await openAIResponse.text();
    console.error('[OpenAI TTS API Error]', errText);
    throw new Error(`OpenAI TTS API failed with status ${openAIResponse.status}: ${errText}`);
  }

  const arrayBuffer = await openAIResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function enhancePromptWithGPT(
  situationPrompt: string,
  scriptText: string,
  endSituationPrompt?: string,
  isNoSpeech?: boolean,
  visualStyle?: string,
  characterDescription?: string,
  characterEmotion?: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[GPT Enhance] Missing OPENAI_API_KEY. Using original prompt.');
    return situationPrompt || '';
  }

  let systemMessage = `You are an expert AI Prompt Engineer specialized in video generation models (Wan 2.5 and Kling 2.5).
Your task is to take a simple Thai or English visual description (situation) and enhance it into a highly detailed English visual prompt for a video.

Guidelines:
1. Translate the situation description to English if it is in Thai.
2. Expand it to describe cinematic details: camera angle, lighting, details of the subject, and background matching the situation.
3. Keep the prompt under 180 words.
4. Return ONLY the enhanced English visual prompt. Do NOT add any greeting, explanation, markdown formatting, or quotes.
5. Describe realistic ambient sounds from the scene and sound effects generated by the actions of the characters or objects matching the situation. Explicitly specify the audio hierarchy and volume levels: main action sounds must be the loudest, while environmental ambient sounds should be secondary and lower in volume (quiet background level).`;

  if (!isNoSpeech) {
    systemMessage = `You are an expert AI Prompt Engineer specialized in video generation models (Wan 2.5 and Kling 2.5).
Your task is to take a simple Thai or English visual description (situation) and a speech script, and enhance it into a highly detailed English visual prompt for a talking head/avatar video.

Guidelines:
1. Translate the situation description to English if it is in Thai.
2. Expand it to describe cinematic details: camera angle (medium close-up, close-up, talking portrait), lighting (soft studio light, cinematic lighting), details of the person (natural facial features, clear lip movements, natural blinking, high detail skin texture), and background matching the situation.
3. Incorporate the context/tone of the speech script to match the facial expressions (e.g., warm smile if it's friendly, serious expression if it's formal).
4. Do NOT include the actual spoken words inside the prompt itself, only describe the visual scene and speech actions.
5. Keep the prompt under 180 words.
6. Return ONLY the enhanced English visual prompt. Do NOT add any greeting, explanation, markdown formatting, or quotes.
7. Describe realistic ambient sounds from the scene (e.g., wind blowing, indoor hum, background music) and sound effects generated by the actions of the characters or objects (e.g., a slap sound, footsteps, cloth rustling) matching the situation. Explicitly specify the audio hierarchy and volume levels: speech/dialogue must be the loudest and most prominent, while environmental ambient sounds and action-based sound effects should be secondary and lower in volume (quiet background level).
8. You MUST explicitly include visual timing instructions in the generated prompt for the video generation model: specify that the character must remain silent with their mouth completely closed and no lip movement for exactly 1 second at the very beginning of the video (before they start speaking), and the character must also remain silent with their mouth completely closed and no lip movement for exactly 1 second at the very end of the video (after they finish speaking, before the video ends).`;
  }

  let userMessage = `Situation description: "${situationPrompt || 'A person talking naturally'}"`;
  if (!isNoSpeech) {
    userMessage += `\nSpeech script: "${scriptText || ''}"`;
  }

  if (characterDescription) {
    userMessage += `\nCharacter Visual Signature (Describe this person exactly): "${characterDescription}"`;
  }

  if (characterEmotion) {
    userMessage += `\nSubject's Emotion/Mood (Apply this expression and body language): "${characterEmotion}"`;
  }

  if (endSituationPrompt) {
    userMessage += `\nEnd situation description (for morphing/transition to the end frame): "${endSituationPrompt}"
Please structure the enhanced prompt to describe a continuous, smooth visual transition/morphing from the starting situation to the ending situation.`;
  }

  if (visualStyle && visualStyle !== 'none') {
    const styleDescriptions: Record<string, string> = {
      cinematic: 'Cinematic visual style with dramatic cinematic lighting, deep shadows, rich color grading, and high contrast.',
      studio: 'Studio portrait style with clean professional studio lighting, soft key light, and shallow depth of field (blurred background).',
      pixar: '3D Pixar animation style, stylized character features, vibrant colors, clean and smooth rendering, and cartoon aesthetic.',
      retro: 'Retro 90s visual style, warm film grain, retro color palettes, VHS style aesthetic, and nostalgia feel.',
      anime: 'Japanese anime visual style, drawn line-art, cell-shaded coloring, hand-drawn anime aesthetic, and stylized eyes.'
    };
    const styleDesc = styleDescriptions[visualStyle] || '';
    if (styleDesc) {
      userMessage += `\nVisual Style Constraint: Apply this aesthetic style: "${styleDesc}"`;
    }
  }

  try {
    console.log('[GPT Enhance] Enhancing prompt with gpt-4o-mini...');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 250,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[GPT Enhance API Error] Status: ${response.status}, Error:`, errText);
      return situationPrompt || '';
    }

    const resJson = await response.json();
    const enhancedPrompt = resJson.choices?.[0]?.message?.content?.trim();
    if (enhancedPrompt) {
      console.log('[GPT Enhance] Original situation prompt:', situationPrompt);
      console.log('[GPT Enhance] Enhanced prompt:', enhancedPrompt);
      return enhancedPrompt;
    }
  } catch (error) {
    console.warn('[GPT Enhance Exception] Failed to run enhancement:', error);
  }

  return situationPrompt || '';
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
    const imageFile = formData.get('image') as File | null;
    const endImageFile = formData.get('end_image') as File | null;
    const customAudioFile = formData.get('custom_audio') as File | null;
    const isNoSpeech = formData.get('is_no_speech') === 'true';
    const visualStyle = formData.get('visual_style') as string || 'none';
    const videoFile = formData.get('video') as File;
    const motionAudioSource = formData.get('motion_audio_source') as string || 'video';
    const scriptText = formData.get('script_text') as string;
    const situationPrompt = formData.get('situation_prompt') as string;
    const endSituationPrompt = formData.get('end_situation_prompt') as string || '';
    const voiceId = formData.get('voice_id') as string;
    const aspectRatio = (formData.get('aspect_ratio') as string) || '16:9';
    const userEmail = formData.get('user_email') as string;
    const userId = formData.get('user_id') as string;
    const modelType = formData.get('model_type') as string || 'fast';
    const storageProvider = formData.get('storage_provider') as string || 'supabase';
    const ttsProvider = formData.get('tts_provider') as string || 'botnoi';
    const selectedDuration = parseInt(formData.get('duration') as string || '8', 10);
    const safetyFilterDisabled = formData.get('safety_filter_disabled') === 'true';

    // Character library, speech speed and emotion extraction
    const characterId = formData.get('character_id') as string || '';
    const characterName = formData.get('character_name') as string || '';
    const characterDescription = formData.get('character_description') as string || '';
    const characterNegativePrompt = formData.get('character_negative_prompt') as string || '';
    const characterImageUrl = formData.get('character_image_url') as string || '';
    const speedFactor = parseFloat(formData.get('speed_factor') as string || '1.0');
    const characterEmotion = formData.get('character_emotion') as string || '';

    const isMotionControl = modelType === 'motion-control';

    const useLoraModel = formData.get('use_lora_model') === 'true';
    const loraModelUrl = formData.get('lora_model_url') as string || '';
    const loraTriggerWord = formData.get('lora_trigger_word') as string || '';

    if (isMotionControl) {
      if ((!imageFile && !characterImageUrl) || !videoFile || !userEmail) {
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
      if ((!imageFile && !characterImageUrl && !useLoraModel) || (!isNoSpeech && !scriptText) || !userEmail) {
        return NextResponse.json(
          { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกรูปภาพและข้อความให้ครบ' },
          { status: 400 }
        );
      }
    }

    const falKey = process.env.FAL_KEY;
    if (!falKey) throw new Error('ไม่พบ FAL_KEY ในระบบ');

    const timestamp = Date.now();

    // 0. Enhance prompt with GPT-4o-mini
    console.log('[STEP 0.5] Enhancing prompt with gpt-4o-mini...');
    const combinedPrompt = await enhancePromptWithGPT(
      situationPrompt,
      scriptText,
      modelType === 'fast' ? endSituationPrompt : undefined,
      isNoSpeech,
      visualStyle,
      characterDescription,
      characterEmotion
    );

    // 1. Upload/Generate reference image
    let imageUrl = '';
    let imagePath = '';

    if (useLoraModel && loraModelUrl && loraTriggerWord) {
      console.log('[STEP 1] Generating reference image using Character LoRA model...');
      const fluxPrompt = `photo of ${loraTriggerWord}, ${combinedPrompt}`;
      console.log(`[LoRA Flux Prompt]: ${fluxPrompt}`);

      let imageSize = 'landscape_16_9';
      if (aspectRatio === '9:16') {
        imageSize = 'portrait_16_9';
      } else if (aspectRatio === '1:1') {
        imageSize = 'square_hd';
      }

      const fluxResponse = await fetch('https://fal.run/fal-ai/flux-lora', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: fluxPrompt,
          loras: [
            {
              path: loraModelUrl,
              scale: 1.0,
            }
          ],
          image_size: imageSize,
          num_inference_steps: 28,
          enable_safety_checker: true,
        }),
      });

      if (!fluxResponse.ok) {
        const errText = await fluxResponse.text();
        console.error('[LoRA Flux Generation Error]', errText);
        throw new Error('เจเนอเรตภาพเริ่มต้นด้วยโมเดลตัวละคร (LoRA) ไม่สำเร็จ');
      }

      const fluxResult = await fluxResponse.json();
      imageUrl = fluxResult.images?.[0]?.url;
      console.log('[STEP 1] Generated image from LoRA model:', imageUrl);

      if (!imageUrl) {
        throw new Error('ไม่พบ URL ภาพผลลัพธ์ที่เทรนด้วย LoRA');
      }
    } else if (imageFile) {
      console.log('[STEP 1] Uploading reference image to Supabase...');
      const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
      imagePath = `references/${userEmail}/${timestamp}_ref.${imageFile.type.split('/')[1] || 'png'}`;
      imageUrl = await uploadToSupabaseStorage(imageBuffer, imagePath, imageFile.type);
      console.log('[STEP 1] Image uploaded:', imageUrl);
    } else if (characterImageUrl) {
      console.log('[STEP 1] Using character library image URL:', characterImageUrl);
      imageUrl = characterImageUrl;
    }

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

    // 1.7. Upload end reference image if present (Kling 2.5 visual morphing)
    let endImageUrl = '';
    let endImagePath = '';
    if (modelType === 'fast' && endImageFile) {
      console.log('[STEP 1.7] Uploading end reference image to Supabase...');
      const endImageBuffer = Buffer.from(await endImageFile.arrayBuffer());
      endImagePath = `references/${userEmail}/${timestamp}_end_ref.${endImageFile.type.split('/')[1] || 'png'}`;
      endImageUrl = await uploadToSupabaseStorage(endImageBuffer, endImagePath, endImageFile.type);
      console.log('[STEP 1.7] End image uploaded:', endImageUrl);
    }

    // 2. Generate Thai TTS audio (only if needed)
    let audioUrl = '';
    let audioPath = '';
    const needTTS = !isNoSpeech && (!isMotionControl || (isMotionControl && motionAudioSource === 'botnoi'));
    
    if (needTTS) {
      if (customAudioFile) {
        console.log('[STEP 2] Custom audio file uploaded. Saving to Supabase...');
        const audioBuffer = Buffer.from(await customAudioFile.arrayBuffer());
        audioPath = `audio/${userEmail}/${timestamp}_custom_tts.${customAudioFile.type.split('/')[1] || 'mp3'}`;
        audioUrl = await uploadToSupabaseStorage(audioBuffer, audioPath, customAudioFile.type);
        console.log('[STEP 2] Custom audio uploaded:', audioUrl);
      } else if (scriptText) {
        console.log(`[STEP 2] Generating TTS audio using provider: ${ttsProvider}, voice ID: ${voiceId} with speed: ${speedFactor}...`);
        let audioBuffer: Buffer;
        if (ttsProvider === 'google') {
          audioBuffer = await generateGoogleTTS(scriptText, voiceId, speedFactor);
        } else if (ttsProvider === 'openai') {
          audioBuffer = await generateOpenAITTS(scriptText, voiceId, speedFactor);
        } else {
          audioBuffer = await generateTTS(scriptText, voiceId, speedFactor);
        }
        audioPath = `audio/${userEmail}/${timestamp}_tts.mp3`;
        audioUrl = await uploadToSupabaseStorage(audioBuffer, audioPath, 'audio/mpeg');
        console.log('[STEP 2] TTS audio uploaded:', audioUrl);
      }
    }

    // 3. Configure endpoint
    const isCinema = modelType === 'cinema';
    const isMotionControlModel = modelType === 'motion-control';
    const isGrok = modelType === 'grok-video';
    const modelEndpoint = isCinema
      ? 'fal-ai/wan-i2v'
      : (isMotionControlModel 
          ? 'fal-ai/kling-video/v2.6/standard/motion-control' 
          : (isGrok ? 'xai/grok-imagine-video/v1.5/image-to-video' : 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video')
        );

    // 4. Build Fal.ai request body
    let requestBody: Record<string, any>;
    if (isCinema) {
      const wanParams = getWanVideoParams(selectedDuration);
      console.log(`[Wan 2.5 Cinema Params] Selected duration: ${selectedDuration}s => Calculated frames: ${wanParams.num_frames}, FPS: ${wanParams.frames_per_second}`);
      
      let negativePrompt = 'blurry, distorted, low quality, static, frozen';
      if (characterNegativePrompt) {
        negativePrompt += `, ${characterNegativePrompt}`;
      }

      requestBody = {
        image_url: imageUrl,
        audio_url: audioUrl,
        prompt: combinedPrompt,
        negative_prompt: negativePrompt,
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
      if (characterNegativePrompt) {
        requestBody.negative_prompt = characterNegativePrompt;
      }
    } else {
      requestBody = {
        image_url: imageUrl,
        prompt: combinedPrompt,
        aspect_ratio: aspectRatio === '16:9' ? '16:9' : aspectRatio === '9:16' ? '9:16' : '1:1',
        duration: selectedDuration <= 5 ? 5 : 10,
      };
      if (characterNegativePrompt) {
        requestBody.negative_prompt = characterNegativePrompt;
      }
      if (modelType === 'fast' && endImageUrl) {
        requestBody.tail_image_url = endImageUrl;
      }
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
            script_text: isNoSpeech ? '' : (isMotionControl && motionAudioSource === 'video' ? '' : scriptText),
            situation_prompt: situationPrompt || '',
            end_situation_prompt: modelType === 'fast' ? endSituationPrompt : '',
            is_no_speech: isNoSpeech,
            visual_style: visualStyle,
            model_name: isMotionControl 
              ? 'kling-2.6-motion-control' 
              : (isCinema 
                  ? 'wan-2.5-cinema' 
                  : (modelType === 'grok-video' ? 'grok-1.5-imagine-video' : 'kling-2.5-turbo')
                ),
            voice_id: isNoSpeech ? '' : (isMotionControl && motionAudioSource === 'video' ? '' : voiceId),
            tts_provider: isNoSpeech ? 'none' : (customAudioFile ? 'custom_upload' : ttsProvider),
            storage_provider: storageProvider,
            aspect_ratio: isMotionControl ? 'auto' : aspectRatio,
            duration_estimate: selectedDuration,
            storage_path: videoPath,
            image_path: imagePath,
            end_image_path: endImagePath || null,
            end_image_url: endImageUrl || null,
            audio_path: audioPath || null,
            driving_path: refVideoPath || null,
            // Character Library, Speech Speed, and Emotion details
            character_id: characterId || null,
            character_name: characterName || null,
            character_description: characterDescription || null,
            character_negative_prompt: characterNegativePrompt || null,
            speed_factor: speedFactor,
            character_emotion: characterEmotion || null
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
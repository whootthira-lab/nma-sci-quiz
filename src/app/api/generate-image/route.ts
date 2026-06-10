import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function enhanceImagePromptWithGPT(
  prompt: string,
  visualStyle: string,
  cameraAngle: string,
  cameraZoom: string,
  characterDescription?: string,
  characterEmotion?: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[GPT Image Enhance] Missing OpenAI API Key. Using original prompt.');
    return prompt;
  }

  let systemInstruction = `You are an expert AI Prompt Engineer specialized in text-to-image models (specifically Flux.1 and Stable Diffusion).
Your task is to take a simple Thai or English image description and expand it into a highly detailed English visual prompt.

Guidelines:
1. Translate the prompt to English if it is in Thai.
2. Expand it to describe cinematic details: camera framing, lighting style (e.g., volumetric lighting, soft studio light, sunset glow), background atmosphere, texture details (realistic skin texture, cloth textures), and depth of field.
3. Incorporate the requested visual style, camera angle, and camera zoom level into the description organically.
4. Keep the prompt under 180 words.
5. Return ONLY the enhanced English prompt. Do NOT add markdown, quotes, greetings, or explanations.
6. VERY IMPORTANT: If the prompt contains a specific character trigger word (e.g., kruthsomsri, whootthiraman), you MUST preserve it exactly as-is and make it the subject of the sentence. Do NOT translate, modify, or delete the trigger word.`;

  let userMessage = `Original Prompt: "${prompt}"`;
  if (visualStyle && visualStyle !== 'none') {
    userMessage += `\nVisual Style: "${visualStyle}"`;
  }
  if (cameraAngle && cameraAngle !== 'default' && cameraAngle !== 'none') {
    userMessage += `\nCamera Angle: "${cameraAngle}"`;
  }
  if (cameraZoom && cameraZoom !== 'default' && cameraZoom !== 'none') {
    userMessage += `\nCamera Zoom/Framing: "${cameraZoom}"`;
  }
  if (characterDescription) {
    userMessage += `\nSubject Description (Visual Signature): "${characterDescription}"`;
  }
  if (characterEmotion) {
    userMessage += `\nSubject's Emotion/Expression: "${characterEmotion}"`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 250,
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[GPT Image Enhance Error] Status: ${response.status}`);
      return prompt;
    }

    const resJson = await response.json();
    const enhanced = resJson.choices?.[0]?.message?.content?.trim();
    if (enhanced) {
      return enhanced;
    }
  } catch (err: any) {
    console.warn('[GPT Image Enhance Exception]', err.message || err);
  }

  return prompt;
}

export async function POST(req: NextRequest) {
  try {
    console.log('\n==================================');
    console.log('[IMAGE GEN API] Starting Image Generation Request');

    const formData = await req.formData();

    // Initialize Supabase Client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get input parameters
    const prompt = formData.get('prompt') as string;
    const imageFile = formData.get('image') as File | null;
    const maskFile = formData.get('mask') as File | null;
    const imageMode = formData.get('image_mode') as string || 'text_to_image'; // 'text_to_image' | 'image_to_image' | 'inpainting' | 'outpainting'
    const modelType = formData.get('model_type') as string || 'flux_dev'; // 'flux_dev' | 'flux_schnell'
    const visualStyle = formData.get('visual_style') as string || 'none';
    const cameraAngle = formData.get('camera_angle') as string || 'default';
    const cameraZoom = formData.get('camera_zoom') as string || 'default';
    const characterId = formData.get('character_id') as string || '';
    const userEmail = formData.get('user_email') as string;
    const userId = formData.get('user_id') as string;
    const strength = parseFloat(formData.get('strength') as string || '0.65');
    const aspectRatio = formData.get('aspect_ratio') as string || '1:1';
    const storageProvider = formData.get('storage_provider') as string || 'supabase';

    if (!prompt || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกข้อความ Prompt และอีเมลผู้ใช้' },
        { status: 400 }
      );
    }

    // Verify Whitelist and Credits Balance
    const isSuperAdmin = userEmail === 'whootthira@gmail.com';
    let whitelistUser: any = null;
    try {
      const { data } = await supabase
        .from('whitelist')
        .select('generation_limit, expires_at')
        .eq('email', userEmail)
        .single();
      whitelistUser = data;
    } catch (e) {
      console.warn('Error reading whitelist entry:', e);
    }

    if (!isSuperAdmin) {
      if (!whitelistUser) {
        return NextResponse.json(
          { success: false, error: 'ขออภัย บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาตให้ใช้งาน (Not Whitelisted)' },
          { status: 403 }
        );
      }
      if (whitelistUser.expires_at) {
        const isExpired = new Date(whitelistUser.expires_at).getTime() < Date.now();
        if (isExpired) {
          return NextResponse.json(
            { success: false, error: 'ขออภัย สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบ' },
            { status: 403 }
          );
        }
      }
    }

    const cost = 20; // 2.0 credits scaled by 10 = 20 credits
    const userCredits = isSuperAdmin ? 999999 : (whitelistUser?.generation_limit || 0);

    if (!isSuperAdmin && userCredits < cost) {
      return NextResponse.json(
        { success: false, error: `ขออภัย เครดิตคงเหลือของคุณไม่เพียงพอสำหรับการสร้างภาพนี้ (ต้องการ ${(cost / 10).toFixed(1).replace('.0', '')} เครดิต, คงเหลือ ${(userCredits / 10).toFixed(1).replace('.0', '')} เครดิต) กรุณาติดต่อแอดมินเพื่อเติมโควต้า` },
        { status: 403 }
      );
    }

    // Resolve finalUserId
    let finalUserId = userId;
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

    const timestamp = Date.now();

    // 1. Upload input image to Supabase if present
    let imageUrl = '';
    let imagePath = '';
    if (imageFile && imageFile.size > 0) {
      const ext = imageFile.name.split('.').pop() || 'png';
      imagePath = `images/${userEmail}/${timestamp}_src.${ext}`;
      const buffer = Buffer.from(await imageFile.arrayBuffer());
      const { error: uploadErr } = await supabase.storage
        .from('kruth-ai-assets')
        .upload(imagePath, buffer, {
          contentType: imageFile.type,
          upsert: true
        });
      if (!uploadErr) {
        const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(imagePath);
        imageUrl = publicUrl;
      } else {
        console.error('[IMAGE GEN API] Image upload failed:', uploadErr);
      }
    }

    // 2. Upload mask image to Supabase if present
    let maskUrl = '';
    let maskPath = '';
    if (maskFile && maskFile.size > 0) {
      const ext = maskFile.name.split('.').pop() || 'png';
      maskPath = `images/${userEmail}/${timestamp}_mask.${ext}`;
      const buffer = Buffer.from(await maskFile.arrayBuffer());
      const { error: uploadErr } = await supabase.storage
        .from('kruth-ai-assets')
        .upload(maskPath, buffer, {
          contentType: maskFile.type,
          upsert: true
        });
      if (!uploadErr) {
        const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(maskPath);
        maskUrl = publicUrl;
      } else {
        console.error('[IMAGE GEN API] Mask upload failed:', uploadErr);
      }
    }

    // 3. Resolve Character LoRA if selected
    let loraModelUrl = '';
    let loraTriggerWord = '';
    let characterDescription = '';
    let characterEmotion = '';

    if (characterId) {
      try {
        const { data: charData } = await supabase
          .from('characters')
          .select('lora_status, lora_model_url, lora_trigger_word, description, character_emotion')
          .eq('id', characterId)
          .single();
        if (charData && charData.lora_status === 'succeeded' && charData.lora_model_url) {
          loraModelUrl = charData.lora_model_url;
          loraTriggerWord = charData.lora_trigger_word;
          characterDescription = charData.description || '';
          characterEmotion = charData.character_emotion || '';
          console.log(`[IMAGE GEN API] Injecting Character LoRA: ${loraTriggerWord}`);
        }
      } catch (err) {
        console.warn('Error reading character data:', err);
      }
    }

    // Append trigger word to user prompt if using character model
    let combinedPrompt = prompt;
    if (loraTriggerWord) {
      combinedPrompt = `a photo of ${loraTriggerWord}, ${prompt}`;
    }

    // 4. Enhance prompt using GPT-4o-mini
    console.log('[IMAGE GEN API] Enhancing prompt with GPT-4o-mini...');
    const enhancedPrompt = await enhanceImagePromptWithGPT(
      combinedPrompt,
      visualStyle,
      cameraAngle,
      cameraZoom,
      characterDescription,
      characterEmotion
    );

    // 5. Select Fal.ai model endpoint
    let modelEndpoint = 'fal-ai/flux/dev';
    if (imageMode === 'image_to_image') {
      modelEndpoint = 'fal-ai/flux/dev/image-to-image';
    } else if (imageMode === 'inpainting' || imageMode === 'outpainting') {
      modelEndpoint = 'fal-ai/flux/dev/fill';
    } else if (modelType === 'flux_schnell' && !loraModelUrl) {
      modelEndpoint = 'fal-ai/flux/schnell';
    }

    // 6. Build Fal.ai request body
    let requestBody: Record<string, any> = {
      prompt: enhancedPrompt,
      enable_safety_checker: true,
      sync_mode: false
    };

    // Add aspect ratio or custom sizing for non-fill endpoints
    if (imageMode !== 'inpainting' && imageMode !== 'outpainting') {
      requestBody.image_size = aspectRatio === '16:9' ? '1280x720' : (aspectRatio === '9:16' ? '720x1280' : '1024x1024');
    }

    // Attach reference image for I2I
    if (imageMode === 'image_to_image') {
      requestBody.image_url = imageUrl;
      requestBody.strength = strength;
    }

    // Attach image and mask for inpainting/outpainting (Fill)
    if (imageMode === 'inpainting' || imageMode === 'outpainting') {
      requestBody.image_url = imageUrl;
      requestBody.mask_url = maskUrl;
    }

    // Attach LoRA weights if applicable (only supported on Flux Dev endpoints)
    if (loraModelUrl && modelEndpoint.includes('flux/dev')) {
      requestBody.loras = [
        {
          path: loraModelUrl,
          scale: 0.85
        }
      ];
    }

    // 7. Submit job to Fal.ai queue
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY || '';
    if (!falKey) {
      throw new Error('ระบบตรวจสอบไม่พบ API Key ของ Fal.ai (FAL_KEY)');
    }

    console.log(`[IMAGE GEN API] Submitting request to Fal.ai (${modelEndpoint})...`);
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
      console.error(`[IMAGE GEN API Fal.ai Error]`, errText);
      throw new Error('ส่งคำขอสร้างรูปภาพไปยัง Fal.ai ไม่สำเร็จ');
    }

    const submitResult = await submitResponse.json();
    const requestId = submitResult.request_id;
    console.log(`[IMAGE GEN API] Job submitted successfully. Job ID: ${requestId}`);

    if (!requestId) {
      throw new Error('ระบบ AI ไม่ได้ส่งคืน Request ID สำหรับการสร้างภาพ');
    }

    // Deduct credits from user whitelist (except Super Admin)
    if (!isSuperAdmin && whitelistUser) {
      const newCredits = Math.max(0, (whitelistUser.generation_limit || 0) - cost);
      console.log(`[Credits-Image] Deducting ${cost} credits from ${userEmail}. Old balance: ${whitelistUser.generation_limit}, New balance: ${newCredits}`);
      const { error: deductError } = await supabase
        .from('whitelist')
        .update({ generation_limit: newCredits })
        .eq('email', userEmail);
      if (deductError) {
        console.error('[Credits-Image] Failed to deduct credits:', deductError);
      }
    }

    // 8. Save initial generations record in Supabase
    const outputImagePath = `generations/${userEmail}/${timestamp}_output.png`;

    if (finalUserId) {
      console.log(`[IMAGE GEN API] Saving initial database log for user: ${finalUserId}`);
      const { error: dbError } = await supabase
        .from('generations')
        .insert({
          user_id: finalUserId,
          prompt: prompt,
          source_image_url: imageUrl || null,
          status: 'processing',
          fal_request_id: requestId,
          metadata: {
            mode: `image-${imageMode}`, // registers as image mode: image-text_to_image, image-image_to_image, image-inpainting, image-outpainting
            model_name: modelType,
            aspect_ratio: aspectRatio,
            storage_path: outputImagePath,
            image_path: imagePath || null,
            mask_path: maskPath || null,
            storage_provider: storageProvider
          }
        });
      if (dbError) {
        console.error('[IMAGE GEN API DB Error] Failed to insert generation row:', dbError);
      }
    }

    return NextResponse.json({
      success: true,
      requestId,
      videoPath: outputImagePath, // Pass the outputImagePath in the videoPath slot since the generic status checker reads videoPath
    });

  } catch (error: any) {
    console.error('[IMAGE GEN API Exception]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดในการสร้างรูปภาพ' },
      { status: 500 }
    );
  }
}

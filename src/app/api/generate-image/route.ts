import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { falSubmitCompat } from '@/lib/providers/fal';

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
  const geminiKey = process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  if (!apiKey && !geminiKey) {
    console.warn('[Image Enhance] Missing both OpenAI and Gemini keys. Using original prompt.');
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

  // Cost optimization: try Gemini 1.5 Flash first (≈2x cheaper than gpt-4o-mini + free tier),
  // fall back to OpenAI below if it errors or is unavailable.
  if (geminiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemInstruction}\n\n${userMessage}` }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 250 },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (gRes.ok) {
        const gJson = await gRes.json();
        const gText = gJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (gText) return gText;
      } else {
        console.warn(`[Gemini Image Enhance] status ${gRes.status}, falling back to OpenAI`);
      }
    } catch (err: any) {
      console.warn('[Gemini Image Enhance] exception, falling back to OpenAI:', err?.message || err);
    }
  }

  if (!apiKey) return prompt; // Gemini unavailable and no OpenAI key → use original prompt

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

/**
 * Ultra-tier text-to-image picks (5 ก.ย. 2569, each proved with a real render). Sizes are
 * spelled per model: Flux Ultra takes a ratio, Nano Banana Pro a ratio + resolution tier,
 * Seedream and Flux 2 Max a named size, GPT Image a fixed pixel size and a quality tier.
 * Credits are per image (shown), list prices until the bill says otherwise.
 */
const TOP_T2I: Record<string, { endpoint: string; label: string; credits: number; body: (aspect: string) => Record<string, any> }> = {
  flux_ultra: {
    endpoint: 'fal-ai/flux-pro/v1.1-ultra', label: 'Flux 1.1 Pro Ultra', credits: 7,
    body: (a) => ({ aspect_ratio: ['1:1', '16:9', '9:16'].includes(a) ? a : '1:1', safety_tolerance: '2', output_format: 'jpeg', enable_safety_checker: true })
  },
  nanopro_t2i: {
    endpoint: 'fal-ai/nano-banana-pro', label: 'Nano Banana Pro', credits: 15,
    body: (a) => ({ aspect_ratio: ['1:1', '16:9', '9:16'].includes(a) ? a : '1:1', resolution: '1K', output_format: 'jpeg', safety_tolerance: '3' })
  },
  seedream45: {
    endpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image', label: 'Seedream 4.5', credits: 4,
    body: (a) => ({ image_size: a === '16:9' ? 'landscape_16_9' : a === '9:16' ? 'portrait_16_9' : 'square_hd', enable_safety_checker: true })
  },
  gptimage15: {
    endpoint: 'fal-ai/gpt-image-1.5', label: 'GPT Image 1.5', credits: 6,
    body: (a) => ({ image_size: a === '16:9' ? '1536x1024' : a === '9:16' ? '1024x1536' : '1024x1024', quality: 'medium', output_format: 'jpeg' })
  },
  gptimage2: {
    endpoint: 'fal-ai/gpt-image-2', label: 'GPT Image 2', credits: 10,
    body: (a) => ({ image_size: a === '16:9' ? 'landscape_16_9' : a === '9:16' ? 'portrait_16_9' : 'square_hd', quality: 'medium', output_format: 'jpeg' })
  },
  flux2max: {
    endpoint: 'fal-ai/flux-2-max', label: 'Flux 2 Max', credits: 7,
    body: (a) => ({ image_size: a === '16:9' ? 'landscape_16_9' : a === '9:16' ? 'portrait_16_9' : 'square_hd', enable_safety_checker: true, safety_tolerance: '2', output_format: 'jpeg' })
  }
};

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
    // Photos routinely exceed the platform's request body limit (413), so the browser may
    // upload them to storage itself and pass URLs instead. Files still work for small ones.
    const preUploadedImageUrl = (formData.get('image_url') as string) || '';
    const preUploadedMaskUrl = (formData.get('mask_url') as string) || '';
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
    const skipEnhance = formData.get('skip_enhance') === 'true';
    // Rotating a viewpoint still drifts a likeness a little; putting the original face
    // back afterwards closes most of that gap. Opt-in, and only where there is a face.
    const restoreFace = formData.get('restore_face') === 'true';
    // Which editor turns the view. Measured against the provider's balance: the pricier
    // ones are sharper but drift the face, so the cheapest capable one is the default.
    const editModel = (formData.get('edit_model') as string) || 'flux2';
    const EDIT_MODELS: Record<string, { endpoint: string; credits: number }> = {
      flux2:    { endpoint: 'fal-ai/flux-2-pro/edit',     credits: 30 },   // ~$0.023
      nano:     { endpoint: 'fal-ai/nano-banana/edit',    credits: 40 },   // ~$0.03
      nanopro:  { endpoint: 'fal-ai/nano-banana-pro/edit', credits: 150 }, // ~$0.15
      gptimage: { endpoint: 'fal-ai/gpt-image-1/edit-image', credits: 140 }, // ~$0.14
      grok:     { endpoint: 'xai/grok-imagine-image/edit', credits: 30 },  // ~$0.022
      grokq:    { endpoint: 'xai/grok-imagine-image/quality/edit', credits: 70 } // ~$0.06
    };
    // Every one of these takes an image and an instruction, so they can serve any mode that
    // works that way — not just the viewpoint turn they were first added for. Left alone
    // ("auto") each mode keeps the purpose-built endpoint it has always used, which is
    // still the cheaper and steadier choice for the narrow jobs like relight or cut-out.
    const EDIT_CAPABLE_MODES = ['camera', 'kontext', 'image_to_image', 'relight', 'colorgrade', 'bgreplace'];
    const pickedEditor = EDIT_MODELS[editModel]; // undefined when the caller said 'auto'
    // The viewpoint turn has no purpose-built endpoint to fall back on.
    const chosenEditor = imageMode === 'camera' ? (pickedEditor || EDIT_MODELS.flux2) : pickedEditor;
    const useChosenEditor = !!chosenEditor && EDIT_CAPABLE_MODES.includes(imageMode);

    if (!prompt || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกข้อความ Prompt และอีเมลผู้ใช้' },
        { status: 400 }
      );
    }

    // Verify Whitelist and Credits Balance
    const isSuperAdmin = userEmail === 'whootthira@gmail.com';
    let whitelistUser: any = null;
    // "The lookup failed" and "no such row" must part ways here: maybeSingle answers
    // data:null with NO error when the row is absent, so a thrown/returned error can only
    // mean the lookup itself broke — and that says nothing about the person's permission.
    // Conflating them told legitimate users "Not Whitelisted" whenever the database
    // stuttered for a moment. The email is matched lowercase, the way the admin page
    // stores it.
    let whitelistLookupFailed = false;
    try {
      const { data, error } = await supabase
        .from('whitelist')
        .select('generation_limit, expires_at')
        .eq('email', (userEmail || '').trim().toLowerCase())
        .maybeSingle();
      if (error) throw error;
      whitelistUser = data;
    } catch (e) {
      whitelistLookupFailed = true;
      console.warn('Whitelist lookup failed (transient):', e);
    }

    if (!isSuperAdmin) {
      if (whitelistLookupFailed) {
        return NextResponse.json(
          { success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ กรุณากดสร้างใหม่อีกครั้ง (สิทธิ์ของคุณไม่ได้ถูกเพิกถอน)' },
          { status: 503 }
        );
      }
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

    // Measured against the provider's balance rather than guessed: a Schnell draft costs
    // a fraction of a cent while an upscale runs tens of times that, so charging one flat
    // price meant the cheap modes subsidised the expensive ones. Credits are stored x10.
    const creditsForMode = (): number => {
      // The fill model bills per megapixel of input AND output — August usage shows
      // ~$0.117 per real-world call, not the $0.02 these modes were charged.
      if (imageMode === 'inpainting' || imageMode === 'outpainting') return 120;
      if (imageMode === 'upscale') return 100;                   // $0.03/MP × a typical 3MP+ output
      if (useChosenEditor) return chosenEditor!.credits;    // charge for the model picked
      if (imageMode === 'kontext') return 40;
      if (imageMode === 'relight' || imageMode === 'colorgrade' || imageMode === 'bgreplace') return 30;
      if (modelType === 'flux_schnell' && !characterId) return 10;       // fast draft
      if (modelType === 'grok') return 30;                        // ~$0.02 per image at 1k
      if (modelType === 'flux2pro') return 40;                    // ~$0.03 for the first megapixel
      if (TOP_T2I[modelType]) return TOP_T2I[modelType].credits * 10; // ultra-tier picks, see table
      return 20;                                                  // Flux dev and the mask flows
    };
    const cost = creditsForMode();
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
    let imageUrl = preUploadedImageUrl;
    let imagePath = '';
    if (!imageUrl && imageFile && imageFile.size > 0) {
      const ext = imageFile.name.split('.').pop() || 'png';
      imagePath = `images/${userEmail}/${timestamp}_src.${ext}`;
      const buffer = Buffer.from(await imageFile.arrayBuffer());
      const { error: uploadErr } = await supabase.storage
        .from('kruth-ai-assets')
        .upload(imagePath, buffer, {
          contentType: imageFile.type,
          upsert: true
        });
      if (uploadErr) {
        // Carrying on would hand the model an empty image_url, which comes back as the
        // baffling "Failed to download the file" instead of the real storage problem.
        console.error('[IMAGE GEN API] Image upload failed:', uploadErr);
        return NextResponse.json(
          { success: false, error: `เก็บรูปต้นฉบับไม่สำเร็จ: ${uploadErr.message}` },
          { status: 500 }
        );
      }
      const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(imagePath);
      imageUrl = publicUrl;
    }

    // 2. Upload mask image to Supabase if present
    let maskUrl = preUploadedMaskUrl;
    let maskPath = '';
    if (!maskUrl && maskFile && maskFile.size > 0) {
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

    // The camera angle only ever reached the model through the enhancer, so skipping it
    // (or using a mode that always skips it) silently dropped the setting. Fold it into
    // the prompt directly in that case.
    if (cameraAngle && cameraAngle !== 'default' && cameraAngle !== 'none') {
      const alreadyMentions = combinedPrompt.toLowerCase().includes(cameraAngle.toLowerCase().slice(0, 20));
      if (!alreadyMentions) {
        // Kontext follows instructions rather than descriptions, and it is the only mode
        // that genuinely moves the viewpoint — phrase the angle as something to do, and
        // tell it to hold the subject steady while doing it.
        // Naming what must NOT change matters more than naming the new angle: without it
        // the model quietly restyles the face and body while turning the view. But the
        // list of what to hold must not include the background: a camera that orbits
        // MUST see the scene from somewhere else, so demanding an identical background
        // contradicts the move, and the contradiction was being settled by leaving the
        // camera where it was and restyling the face instead — the exact complaint. So
        // the background is now pinned as the same place seen from the new position, and
        // the no-op is ruled out explicitly.
        combinedPrompt = (imageMode === 'camera' || imageMode === 'kontext')
          ? `${combinedPrompt ? combinedPrompt + '. ' : ''}Orbit the camera around the subject to this exact viewpoint: ${cameraAngle}. The subject does not move, turn or re-pose — only the camera moves, so this is the same room, same background and same lighting seen from the new position, with the perspective shifting accordingly. Keep the exact same person: identical facial features, identical skin tone, identical body shape and proportions, identical hairstyle and identical clothing. Do not restyle, beautify, slim or reshape anything. Do not keep the original camera angle.`
          : `${combinedPrompt}, ${cameraAngle}`;
      }
    }
    if (cameraZoom && cameraZoom !== 'default' && cameraZoom !== 'none') {
      combinedPrompt = `${combinedPrompt}, ${cameraZoom}`;
    }

    // 4. Enhance prompt (Gemini Flash → OpenAI), unless the user opted out
    let enhancedPrompt = combinedPrompt;
    if (skipEnhance || useChosenEditor || ['kontext', 'relight', 'colorgrade', 'camera', 'upscale', 'bgreplace'].includes(imageMode)) {
      console.log('[IMAGE GEN API] Skipping enhancer (opt-out or edit-mode instruction) → using original prompt');
    } else {
      console.log('[IMAGE GEN API] Enhancing prompt (Gemini Flash → OpenAI fallback)...');
      enhancedPrompt = await enhanceImagePromptWithGPT(
        combinedPrompt,
        visualStyle,
        cameraAngle,
        cameraZoom,
        characterDescription,
        characterEmotion
      );
    }

    if (imageMode === 'kontext' && !imageUrl) {
      return NextResponse.json(
        { success: false, error: 'โหมดแก้ภาพ (Kontext) ต้องอัปโหลดรูปต้นฉบับก่อน' },
        { status: 400 }
      );
    }

    // The model fetches this URL itself, so a link the browser could write but the world
    // cannot read fails far away from the cause. Check it here, and re-upload with our own
    // credentials when the file we were handed is still in the request.
    if (imageUrl) {
      const reachable = await fetch(imageUrl, { method: 'HEAD' })
        .then((r) => r.ok)
        .catch(() => false);
      if (!reachable) {
        console.warn('[IMAGE GEN API] Source image URL is not reachable:', imageUrl);
        if (imageFile && imageFile.size > 0) {
          const ext = imageFile.name.split('.').pop() || 'png';
          const retryPath = `images/${userEmail}/${timestamp}_src_retry.${ext}`;
          const buffer = Buffer.from(await imageFile.arrayBuffer());
          const { error: retryErr } = await supabase.storage
            .from('kruth-ai-assets')
            .upload(retryPath, buffer, { contentType: imageFile.type, upsert: true });
          if (retryErr) {
            return NextResponse.json(
              { success: false, error: `เก็บรูปต้นฉบับไม่สำเร็จ: ${retryErr.message}` },
              { status: 500 }
            );
          }
          const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(retryPath);
          imageUrl = publicUrl;
          imagePath = retryPath;
        } else {
          return NextResponse.json(
            { success: false, error: 'ระบบเข้าถึงรูปต้นฉบับไม่ได้ กรุณาอัปโหลดรูปใหม่อีกครั้ง' },
            { status: 400 }
          );
        }
      }
    }

    // Every mode that edits an existing picture needs one; without this check the request
    // reaches the model with an empty image_url and fails there for an unrelated-looking reason.
    if (['image_to_image', 'inpainting', 'outpainting', 'camera', 'upscale', 'bgreplace'].includes(imageMode) && !imageUrl) {
      return NextResponse.json(
        { success: false, error: 'โหมดนี้ต้องมีรูปต้นฉบับ แต่ระบบไม่ได้รับรูป กรุณาอัปโหลดรูปใหม่อีกครั้ง' },
        { status: 400 }
      );
    }

    if ((imageMode === 'relight' || imageMode === 'colorgrade') && !imageUrl) {
      return NextResponse.json(
        { success: false, error: 'โหมดนี้ต้องอัปโหลดรูปต้นฉบับก่อน' },
        { status: 400 }
      );
    }

    // 5. Select Fal.ai model endpoint
    let modelEndpoint = 'fal-ai/flux/dev';
    if (imageMode === 'image_to_image') {
      modelEndpoint = 'fal-ai/flux/dev/image-to-image';
    } else if (imageMode === 'inpainting' || imageMode === 'outpainting') {
      // fal-ai/flux/dev/fill does not exist: the queue accepts the job and the worker
      // then answers "Path /dev/fill not found" when the result is fetched. Verified
      // through to a returned image that this one works.
      modelEndpoint = 'fal-ai/flux-pro/v1/fill';
    } else if (imageMode === 'camera') {
      modelEndpoint = chosenEditor!.endpoint;
    } else if (imageMode === 'upscale') {
      modelEndpoint = 'fal-ai/clarity-upscaler';
    } else if (imageMode === 'bgreplace') {
      modelEndpoint = 'fal-ai/bria/background/replace';
    } else if (imageMode === 'kontext') {
      modelEndpoint = 'fal-ai/flux-pro/kontext';
    } else if (imageMode === 'relight') {
      modelEndpoint = 'fal-ai/iclight-v2'; // relighting from a lighting-description prompt
    } else if (imageMode === 'colorgrade') {
      modelEndpoint = 'fal-ai/image-editing/color-correction'; // color/tone correction
    } else if (modelType === 'grok' && !loraModelUrl) {
      modelEndpoint = 'xai/grok-imagine-image';
    } else if (modelType === 'flux2pro' && !loraModelUrl) {
      modelEndpoint = 'fal-ai/flux-2-pro';
    } else if (modelType === 'flux_schnell' && !loraModelUrl) {
      modelEndpoint = 'fal-ai/flux/schnell';
    } else if (TOP_T2I[modelType] && !loraModelUrl) {
      modelEndpoint = TOP_T2I[modelType].endpoint;
    }

    // An explicit pick overrides the mode's own endpoint, for every mode that works by
    // handing a model an image and an instruction.
    if (useChosenEditor) {
      modelEndpoint = chosenEditor!.endpoint;
    }

    // A trained character is a Flux LoRA, and only a Flux model can load it. Refusing here
    // beats quietly generating a stranger with the character's name on the bill.
    if ((modelType === 'grok' || modelType === 'flux2pro' || TOP_T2I[modelType]) && loraModelUrl) {
      const name = modelType === 'grok' ? 'Grok' : modelType === 'flux2pro' ? 'Flux 2 Pro' : TOP_T2I[modelType].label;
      return NextResponse.json(
        { success: false, error: `${name} ยังใช้ตัวละครที่เทรนไว้ (LoRA) ไม่ได้ กรุณาเลือกโมเดล Flux Dev หรือเอาตัวละครออกก่อน` },
        { status: 400 }
      );
    }

    // 6. Build Fal.ai request body
    let requestBody: Record<string, any> = {
      prompt: enhancedPrompt,
      enable_safety_checker: true,
      sync_mode: false
    };

    // Add aspect ratio or custom sizing for non-fill endpoints.
    // Fal flux expects image_size as an object { width, height } (or one of its enum strings) —
    // sending a "1024x1024" string fails validation with HTTP 422.
    if (!['inpainting', 'outpainting', 'kontext', 'relight', 'colorgrade', 'camera', 'upscale', 'bgreplace'].includes(imageMode)) {
      if (modelEndpoint.startsWith('xai/')) {
        // Grok sizes by ratio and a quality tier instead of pixel dimensions, and has no
        // safety flag of its own to pass — xAI moderates its own model.
        requestBody.aspect_ratio = ['1:1', '16:9', '9:16'].includes(aspectRatio) ? aspectRatio : '1:1';
        requestBody.resolution = '1k';
        delete requestBody.enable_safety_checker;
      } else if (TOP_T2I[modelType] && modelEndpoint === TOP_T2I[modelType].endpoint) {
        // Each top-tier model spells its size differently; the table knows how.
        requestBody = { prompt: enhancedPrompt, ...TOP_T2I[modelType].body(aspectRatio) };
      } else {
        requestBody.image_size = aspectRatio === '16:9'
          ? { width: 1280, height: 720 }
          : (aspectRatio === '9:16'
              ? { width: 720, height: 1280 }
              : { width: 1024, height: 1024 });
      }
    }

    // Edit modes operate on the uploaded image directly (keep its native dimensions)
    if (['kontext', 'relight', 'colorgrade', 'camera', 'upscale', 'bgreplace'].includes(imageMode) || useChosenEditor) {
      requestBody.image_url = imageUrl;
      delete requestBody.image_size; // the source sets the dimensions
      // These editors take a list of sources rather than a single url. Keyed off the model
      // rather than the mode now that any edit mode can be pointed at one of them.
      if (useChosenEditor || modelEndpoint.startsWith('fal-ai/nano-banana')) {
        delete requestBody.image_url;
        requestBody.image_urls = [imageUrl];
        delete requestBody.enable_safety_checker;
        delete requestBody.sync_mode;
        delete requestBody.aspect_ratio;
        delete requestBody.resolution;
      }
      // The upscaler takes no prompt and safety flags it does not know about
      if (imageMode === 'upscale') {
        delete requestBody.prompt;
        delete requestBody.enable_safety_checker;
        delete requestBody.sync_mode;
      }
    }

    // Attach reference image for I2I. An instruction editor has no strength dial — it is
    // told what to change instead of how far to drift, so the slider does not apply.
    if (imageMode === 'image_to_image' && !useChosenEditor) {
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
    const submitResponse = await falSubmitCompat(modelEndpoint, requestBody);

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
            model_endpoint: modelEndpoint,
            aspect_ratio: aspectRatio,
            // Everything "สร้างอีกครั้ง" needs to refill the form exactly as submitted
            visual_style: visualStyle,
            camera_zoom: cameraZoom,
            edit_model: editModel,
            strength,
            camera_yaw: parseFloat(formData.get('camera_yaw') as string) || 0,
            camera_pitch: parseFloat(formData.get('camera_pitch') as string) || 0,
            character_id: characterId || null,
            storage_path: outputImagePath,
            face_restore_pending: restoreFace && imageMode === 'camera' && !!imageUrl,
            face_restore_source: imageUrl || null,
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
      modelEndpoint, // exact Fal endpoint so the status poller uses the correct queue namespace even when no DB row exists
    });

  } catch (error: any) {
    console.error('[IMAGE GEN API Exception]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดในการสร้างรูปภาพ' },
      { status: 500 }
    );
  }
}

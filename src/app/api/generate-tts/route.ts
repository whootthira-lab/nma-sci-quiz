import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 300; 
export const dynamic = 'force-dynamic';

// ─── Helpers ────────────────────────────────────────

async function uploadToFirebaseStorage(
  buffer: Buffer,
  path: string,
  contentType: string
): Promise<string> {
  try {
    const { adminStorage } = await import('../../../lib/admin'); // ✅ dynamic import
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

  console.log(`[Botnoi] กำลังสร้างเสียงด้วย Speaker ID: ${speakerId}`);

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
      type_media: "mp3"
    }),
  });

  if (!botnoiResponse.ok) {
    throw new Error(`Botnoi API failed: ${botnoiResponse.status}`);
  }

  const data = await botnoiResponse.json();

  if (!data.audio_url) {
    throw new Error('Botnoi did not return audio_url');
  }

  const audioFetch = await fetch(data.audio_url);
  if (!audioFetch.ok) {
    throw new Error('Failed to fetch audio file from Botnoi');
  }

  const arrayBuffer = await audioFetch.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function generateVideoWithWan(
  imageUrl: string,
  prompt: string,
  aspectRatio: string,
  duration: number
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('ไม่พบ FAL_KEY ในระบบ');

  const dimensions: Record<string, { width: number; height: number }> = {
    '1:1': { width: 512, height: 512 },
    '16:9': { width: 832, height: 480 },
    '9:16': { width: 480, height: 832 },
  };
  const dim = dimensions[aspectRatio] || dimensions['16:9'];

  const submitResponse = await fetch('https://queue.fal.run/fal-ai/wan/image-to-video', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_url: imageUrl,
      prompt: prompt || 'A person talking naturally with gentle head movements',
      negative_prompt: 'blurry, distorted, low quality, static, frozen',
      num_frames: Math.min(duration * 8, 240),
      width: dim.width,
      height: dim.height,
      num_inference_steps: 30,
      guidance_scale: 5.0,
      flow_shift: 3.0,
    }),
  });

  if (!submitResponse.ok) {
    const errText = await submitResponse.text();
    console.error(`[Fal.ai Submit Error]`, errText);
    throw new Error('ส่งคำสั่งสร้างวิดีโอไม่สำเร็จ');
  }

  const submitResult = await submitResponse.json();

  if (submitResult.request_id) {
    const requestId = submitResult.request_id;
    console.log(`[Fal.ai] ส่งคิวสำเร็จ Request ID: ${requestId}`);
    
    let result = null;
    let attempts = 0;
    const maxAttempts = 120; 

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;

      const statusResponse = await fetch(
        `https://queue.fal.run/fal-ai/wan/image-to-video/requests/${requestId}/status`,
        { headers: { 'Authorization': `Key ${falKey}` } }
      );
      const statusData = await statusResponse.json();

      if (statusData.status === 'COMPLETED') {
        const resultResponse = await fetch(
          `https://queue.fal.run/fal-ai/wan/image-to-video/requests/${requestId}`,
          { headers: { 'Authorization': `Key ${falKey}` } }
        );
        result = await resultResponse.json();
        break;
      } else if (statusData.status === 'FAILED') {
        throw new Error('การเจนวิดีโอล้มเหลวจากระบบ AI');
      } else {
        process.stdout.write("."); 
      }
    }

    if (!result) throw new Error('หมดเวลารอการเจนวิดีโอ (Timeout)');
    console.log('\n[Fal.ai] เจนวิดีโอเสร็จสมบูรณ์!');
    return result.video?.url || result.output?.video?.url || '';
  }

  return submitResult.video?.url || submitResult.output?.video?.url || '';
}

// ─── Main Handler ───────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    console.log("\n==================================");
    console.log("[STEP 0] ได้รับคำสั่งสร้างวิดีโอใหม่");

    const formData = await req.formData();
    const imageFile = formData.get('image') as File;
    const scriptText = formData.get('script_text') as string;
    const situationPrompt = formData.get('situation_prompt') as string;
    const voiceId = formData.get('voice_id') as string;
    const aspectRatio = (formData.get('aspect_ratio') as string) || '16:9';
    const userEmail = formData.get('user_email') as string;

    if (!imageFile || !scriptText || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณากรอกรูปภาพและข้อความให้ครบ' },
        { status: 400 }
      );
    }

    const timestamp = Date.now();

    // 1. อัปโหลดรูปภาพ
    console.log("[STEP 1] กำลังอัปโหลดรูปภาพ...");
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const imagePath = `references/${userEmail}/${timestamp}_ref.${imageFile.type.split('/')[1] || 'png'}`;
    const imageUrl = await uploadToFirebaseStorage(imageBuffer, imagePath, imageFile.type);
    console.log("[STEP 1] อัปโหลดรูปสำเร็จ");

    // 2. สร้างเสียงพากย์ด้วย Botnoi
    console.log("[STEP 2] กำลังสร้างเสียงพากย์ Botnoi...");
    const audioBuffer = await generateTTS(scriptText, voiceId);
    const audioPath = `audio/${userEmail}/${timestamp}_tts.mp3`;
    await uploadToFirebaseStorage(audioBuffer, audioPath, 'audio/mpeg');
    console.log("[STEP 2] สร้างเสียงพากย์สำเร็จ");

    // 3. ประเมินความยาว
    const cleanText = scriptText.replace(/\s+/g, '').trim();
    const duration = Math.max(3, Math.min(Math.ceil(cleanText.length / 17), 30));

    // 4. สร้างวิดีโอ
    console.log("[STEP 3] กำลังส่งคำสั่งไปที่ Fal.ai...");
    const combinedPrompt = situationPrompt
      ? `${situationPrompt}, talking, lip sync`
      : 'A person talking naturally, gentle expressions, professional setting';

    const tempVideoUrl = await generateVideoWithWan(imageUrl, combinedPrompt, aspectRatio, duration);

    if (!tempVideoUrl) throw new Error('ไม่ได้รับลิงก์วิดีโอจากระบบ AI');

    // 5. โหลดกลับมาเก็บ
    console.log("[STEP 4] กำลังบันทึกวิดีโอ...");
    const videoResponse = await fetch(tempVideoUrl);
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    const videoPath = `videos/${userEmail}/${timestamp}_output.mp4`;
    const persistentVideoUrl = await uploadToFirebaseStorage(videoBuffer, videoPath, 'video/mp4');
    
    console.log("🎉 [SUCCESS] สร้างวิดีโอสำเร็จทุกขั้นตอน!");
    console.log("==================================\n");

    return NextResponse.json({
      success: true,
      video_url: persistentVideoUrl,
      storage_path: videoPath,
      image_url: imageUrl,
      generation_data: {
        user_email: userEmail,
        mode: 'text-to-video',
        script_text: scriptText,
        situation_prompt: situationPrompt || '',
        model_name: 'wan-2.5-cinema',
        voice_id: voiceId,
        image_url: imageUrl,
        video_url: persistentVideoUrl,
        storage_path: videoPath,
        status: 'completed',
        aspect_ratio: aspectRatio,
        duration_estimate: duration,
      },
    });

  } catch (error: any) {
    console.error('\n❌ [ERROR] เกิดข้อผิดพลาด:', error.message || error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดภายในระบบ' },
      { status: 500 }
    );
  }
}
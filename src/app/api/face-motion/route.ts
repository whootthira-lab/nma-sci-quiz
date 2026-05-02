import { NextRequest, NextResponse } from 'next/server';

async function uploadToFirebaseStorage(
  buffer: Buffer,
  path: string,
  contentType: string
): Promise<string> {
  const { getStorage } = await import('firebase-admin/storage');
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  await file.save(buffer, { contentType, public: true });
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 24 * 60 * 60 * 1000,
  });
  return url;
}

async function runFaceMotion(
  imageUrl: string,
  drivingVideoUrl: string,
  modelId: string
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('FAL_KEY not configured');

  const endpoints: Record<string, string> = {
    liveportrait: 'fal-ai/liveportrait',
    hallo: 'fal-ai/hallo',
  };

  const endpoint = endpoints[modelId] || endpoints.liveportrait;

  // Build request body based on model
  let requestBody: Record<string, any>;

  if (modelId === 'liveportrait') {
    requestBody = {
      source_image_url: imageUrl,
      driving_video_url: drivingVideoUrl,
      flag_relative: true,
      flag_pasteback: true,
      flag_do_crop: true,
    };
  } else {
    // Hallo
    requestBody = {
      source_image_url: imageUrl,
      driving_audio_url: drivingVideoUrl, // Hallo uses audio
      pose_weight: 1.0,
      face_weight: 1.0,
      lip_weight: 1.0,
      face_expand_ratio: 1.2,
    };
  }

  // Submit to Fal.ai
  const submitResponse = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errText = await submitResponse.text();
    throw new Error(`Fal.ai submit failed: ${errText}`);
  }

  const submitResult = await submitResponse.json();

  // Poll for result if queue-based
  if (submitResult.request_id) {
    const requestId = submitResult.request_id;
    let result = null;
    let attempts = 0;
    const maxAttempts = 120;

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;

      const statusResponse = await fetch(
        `https://queue.fal.run/${endpoint}/requests/${requestId}/status`,
        { headers: { 'Authorization': `Key ${falKey}` } }
      );
      const statusData = await statusResponse.json();

      if (statusData.status === 'COMPLETED') {
        const resultResponse = await fetch(
          `https://queue.fal.run/${endpoint}/requests/${requestId}`,
          { headers: { 'Authorization': `Key ${falKey}` } }
        );
        result = await resultResponse.json();
        break;
      } else if (statusData.status === 'FAILED') {
        throw new Error(`Face motion generation failed (${modelId})`);
      }
    }

    if (!result) throw new Error('Face motion generation timed out');
    return result.video?.url || result.output?.video?.url || '';
  }

  return submitResult.video?.url || submitResult.output?.video?.url || '';
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const imageFile = formData.get('image') as File;
    const drivingVideoFile = formData.get('driving_video') as File;
    const modelId = formData.get('model_id') as string || 'liveportrait';
    const userEmail = formData.get('user_email') as string;

    if (!imageFile || !drivingVideoFile || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const timestamp = Date.now();

    // 1. Upload reference image
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const imagePath = `references/${userEmail}/${timestamp}_face.${imageFile.type.split('/')[1] || 'png'}`;
    const imageUrl = await uploadToFirebaseStorage(imageBuffer, imagePath, imageFile.type);

    // 2. Upload driving video
    const videoBuffer = Buffer.from(await drivingVideoFile.arrayBuffer());
    const drivingPath = `driving/${userEmail}/${timestamp}_driving.mp4`;
    const drivingVideoUrl = await uploadToFirebaseStorage(videoBuffer, drivingPath, 'video/mp4');

    // 3. Run face motion AI
    const tempVideoUrl = await runFaceMotion(imageUrl, drivingVideoUrl, modelId);

    if (!tempVideoUrl) {
      throw new Error('No video URL returned from face motion AI');
    }

    // 4. Proxy: Download and re-upload to Firebase Storage
    const outputResponse = await fetch(tempVideoUrl);
    const outputBuffer = Buffer.from(await outputResponse.arrayBuffer());
    const outputPath = `videos/${userEmail}/${timestamp}_facemotion.mp4`;
    const persistentUrl = await uploadToFirebaseStorage(outputBuffer, outputPath, 'video/mp4');

    const modelNames: Record<string, string> = {
      liveportrait: 'LivePortrait',
      hallo: 'Hallo',
    };

    return NextResponse.json({
      success: true,
      video_url: persistentUrl,
      storage_path: outputPath,
      generation_data: {
        user_email: userEmail,
        mode: 'face-motion',
        script_text: '',
        situation_prompt: '',
        model_name: modelNames[modelId] || modelId,
        voice_id: '',
        image_url: imageUrl,
        video_url: persistentUrl,
        storage_path: outputPath,
        status: 'completed',
      },
    });
  } catch (error: any) {
    console.error('Face motion error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

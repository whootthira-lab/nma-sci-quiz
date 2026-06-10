import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

async function runFaceMotion(
  imageUrl: string,
  drivingVideoUrl: string,
  modelId: string,
  activeProvider: string
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  const sfKey = process.env.SILICONFLOW_API_KEY || process.env.NEXT_PUBLIC_SILICONFLOW_API_KEY || '';

  if (activeProvider === 'siliconflow' && modelId === 'liveportrait') {
    if (!sfKey) throw new Error('ไม่พบ SILICONFLOW_API_KEY ในระบบ สำหรับการใช้งาน SiliconFlow LivePortrait');
    
    console.log(`[SiliconFlow LivePortrait] Submitting job...`);
    const submitResponse = await fetch('https://api.siliconflow.com/v1/video/submit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sfKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'KlingAI/LivePortrait',
        image: imageUrl,
        driving_video: drivingVideoUrl
      }),
    });

    if (!submitResponse.ok) {
      const errText = await submitResponse.text();
      throw new Error(`SiliconFlow LivePortrait submission failed: ${errText}`);
    }

    const submitResult = await submitResponse.json();
    const requestId = submitResult.requestId;
    console.log(`[SiliconFlow LivePortrait] Job submitted. Request ID: ${requestId}`);

    if (!requestId) {
      throw new Error('SiliconFlow LivePortrait did not return a request ID');
    }

    // Poll SiliconFlow status
    let attempts = 0;
    const maxAttempts = 120;
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;

      console.log(`[SiliconFlow LivePortrait] Polling attempt ${attempts}...`);
      const statusResponse = await fetch('https://api.siliconflow.com/v1/video/status', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId }),
      });

      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const sfStatus = statusData.status;
        console.log(`[SiliconFlow LivePortrait] Current status: ${sfStatus}`);

        if (sfStatus === 'Succeed') {
          return statusData.results?.videos?.[0]?.url || '';
        } else if (sfStatus === 'Failed') {
          throw new Error('SiliconFlow LivePortrait generation failed');
        }
      }
    }
    throw new Error('SiliconFlow LivePortrait generation timed out');
  }

  // Fal.ai logic
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
    const userId = formData.get('user_id') as string;
    const storageProvider = formData.get('storage_provider') as string || 'supabase';

    if (!imageFile || !drivingVideoFile || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

    // Verify whitelist existence & expiration for non-superadmin
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

    // Count daily generations
    const dailyLimit = isSuperAdmin ? 99999 : (whitelistUser?.generation_limit || 10);
    if (finalUserId) {
      const localStartOfDay = new Date();
      localStartOfDay.setHours(0, 0, 0, 0);

      const { count: todaysGensCount } = await supabase
        .from('generations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', finalUserId)
        .gte('created_at', localStartOfDay.toISOString());

      if (todaysGensCount !== null && todaysGensCount >= dailyLimit) {
        return NextResponse.json(
          { success: false, error: `ขออภัย คุณใช้งานเกินขีดจำกัดประจำวันแล้ว (${todaysGensCount}/${dailyLimit} คลิป)` },
          { status: 403 }
        );
      }
    }

    // Fetch system provider config
    let activeProvider = 'siliconflow'; // default fallback
    try {
      const { data: providerConfig } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'open_source_provider')
        .single();
      if (providerConfig?.value) {
        activeProvider = providerConfig.value;
      }
    } catch (e) {
      console.warn('Error fetching open_source_provider setting:', e);
    }

    const timestamp = Date.now();

    // 1. Upload reference image
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const imagePath = `references/${userEmail}/${timestamp}_face.${imageFile.type.split('/')[1] || 'png'}`;
    const imageUrl = await uploadToSupabaseStorage(imageBuffer, imagePath, imageFile.type);

    // 2. Upload driving video
    const videoBuffer = Buffer.from(await drivingVideoFile.arrayBuffer());
    const drivingPath = `driving/${userEmail}/${timestamp}_driving.mp4`;
    const drivingVideoUrl = await uploadToSupabaseStorage(videoBuffer, drivingPath, 'video/mp4');

    // 3. Run face motion AI
    const tempVideoUrl = await runFaceMotion(imageUrl, drivingVideoUrl, modelId, activeProvider);

    if (!tempVideoUrl) {
      throw new Error('No video URL returned from face motion AI');
    }

    // 4. Proxy: Download and re-upload to selected Storage
    const outputResponse = await fetch(tempVideoUrl);
    const outputBuffer = Buffer.from(await outputResponse.arrayBuffer());
    const outputPath = `videos/${userEmail}/${timestamp}_facemotion.mp4`;
    
    let persistentUrl = '';
    if (storageProvider === 'firebase') {
      persistentUrl = await uploadToFirebaseStorage(outputBuffer, outputPath, 'video/mp4');
    } else {
      persistentUrl = await uploadToSupabaseStorage(outputBuffer, outputPath, 'video/mp4');
    }

    const modelNames: Record<string, string> = {
      liveportrait: 'LivePortrait',
      hallo: 'Hallo',
    };

    // 5. Save generation history to Supabase generations table

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

    if (finalUserId) {
      await supabase
        .from('generations')
        .insert({
          user_id: finalUserId,
          prompt: `Face motion using model: ${modelNames[modelId] || modelId}`,
          source_image_url: imageUrl,
          status: 'completed',
          video_url: persistentUrl,
          metadata: {
            mode: 'face-motion',
            model_name: modelNames[modelId] || modelId,
            storage_path: outputPath,
            image_path: imagePath,
            driving_path: drivingPath,
            storage_provider: storageProvider
          }
        });
    }

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
        storage_provider: storageProvider
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

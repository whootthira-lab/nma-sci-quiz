import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const imageFile = formData.get('image') as File | null;
    const userEmail = formData.get('user_email') as string || 'anonymous@kruth.com';

    if (!imageFile || imageFile.size === 0) {
      return NextResponse.json({ success: false, error: 'ไม่พบไฟล์รูปภาพสำหรับการลบพื้นหลัง' }, { status: 400 });
    }

    // Initialize Supabase Client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const timestamp = Date.now();
    const ext = imageFile.name.split('.').pop() || 'png';
    const imagePath = `temp-bg-remove/${userEmail}/${timestamp}_src.${ext}`;
    const buffer = Buffer.from(await imageFile.arrayBuffer());

    // Upload to Supabase Storage
    const { error: uploadErr } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(imagePath, buffer, {
        contentType: imageFile.type,
        upsert: true
      });

    if (uploadErr) {
      console.error('[REMOVE BG] Supabase upload failed:', uploadErr);
      throw new Error('อัปโหลดไฟล์รูปภาพไม่สำเร็จ');
    }

    const { data: { publicUrl: imageUrl } } = supabase.storage
      .from('kruth-ai-assets')
      .getPublicUrl(imagePath);

    console.log(`[REMOVE BG] Uploaded source image. URL: ${imageUrl}`);

    // Call Fal.ai birefnet model
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY || '';
    if (!falKey) {
      throw new Error('ไม่พบ API Key ของ Fal.ai (FAL_KEY) ในระบบ');
    }

    console.log('[REMOVE BG] Sending request to fal-ai/birefnet...');
    const falResponse = await fetch('https://queue.fal.run/fal-ai/birefnet', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        sync_mode: true
      })
    });

    if (!falResponse.ok) {
      const errText = await falResponse.text();
      console.error('[REMOVE BG] Fal.ai BiRefNet request failed:', errText);
      throw new Error('ระบบลบพื้นหลังประมวลผลล้มเหลว');
    }

    const falResult = await falResponse.json();
    const transparentImageUrl = falResult.image?.url;

    if (!transparentImageUrl) {
      throw new Error('ไม่พบผลลัพธ์รูปภาพโปร่งใสจาก Fal.ai');
    }

    console.log(`[REMOVE BG] Success! Transparent image URL: ${transparentImageUrl}`);

    // Cleanup original image in background to save storage space
    try {
      await supabase.storage.from('kruth-ai-assets').remove([imagePath]);
    } catch (cleanupErr) {
      console.warn('[REMOVE BG] Cleanup warning:', cleanupErr);
    }

    return NextResponse.json({
      success: true,
      transparentImageUrl
    });

  } catch (error: any) {
    console.error('[REMOVE BG Exception]', error);
    return NextResponse.json({ success: false, error: error.message || 'เกิดข้อผิดพลาดในการลบพื้นหลัง' }, { status: 500 });
  }
}

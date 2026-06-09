import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const characterId = formData.get('character_id') as string;
    const userEmail = formData.get('user_email') as string;
    const triggerWordRaw = formData.get('trigger_word') as string || '';
    const steps = parseInt(formData.get('steps') as string || '1000', 10);
    const imageFiles = formData.getAll('images') as File[];

    if (!characterId || !userEmail) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน กรุณาระบุรหัสตัวละครและอีเมลผู้ใช้งาน' },
        { status: 400 }
      );
    }

    if (!triggerWordRaw) {
      return NextResponse.json(
        { success: false, error: 'กรุณากรอก Trigger Word สำหรับการฝึกสอนตัวละคร' },
        { status: 400 }
      );
    }

    // Clean trigger word: alphanumeric only, no spaces
    const triggerWord = triggerWordRaw.replace(/[^a-zA-Z0-9]/g, '');
    if (!triggerWord) {
      return NextResponse.json(
        { success: false, error: 'Trigger Word ต้องประกอบด้วยตัวอักษรภาษาอังกฤษและตัวเลขเท่านั้น' },
        { status: 400 }
      );
    }

    if (!imageFiles || imageFiles.length < 6) {
      return NextResponse.json(
        { success: false, error: 'กรุณาอัปโหลดรูปภาพตัวละครเพื่อฝึกสอนอย่างน้อย 6 รูป' },
        { status: 400 }
      );
    }

    if (imageFiles.length > 20) {
      return NextResponse.json(
        { success: false, error: 'ระบบจำกัดการอัปโหลดรูปภาพชุดตัวอย่างได้ไม่เกิน 20 รูป' },
        { status: 400 }
      );
    }

    console.log(`[LoRA Train] Starting ZIP compression for ${imageFiles.length} images...`);

    // 1. Create ZIP in memory
    const zip = new JSZip();
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const buffer = await file.arrayBuffer();
      // Ensure clean filename extension
      const ext = file.name.split('.').pop() || 'png';
      zip.file(`image_${i + 1}.${ext}`, buffer);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    console.log('[LoRA Train] ZIP file compressed successfully, size:', zipBuffer.length);

    // 2. Upload ZIP to Supabase Storage
    const timestamp = Date.now();
    const zipPath = `datasets/${userEmail}/${timestamp}_dataset.zip`;
    
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[LoRA Train] Uploading ZIP dataset to Supabase Storage: ${zipPath}`);
    const { error: uploadError } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(zipPath, zipBuffer, {
        contentType: 'application/zip',
        upsert: true,
      });

    if (uploadError) {
      console.error('[LoRA Train] Supabase ZIP upload failed:', uploadError);
      return NextResponse.json(
        { success: false, error: 'อัปโหลดชุดรูปภาพไปยัง Cloud Storage ไม่สำเร็จ' },
        { status: 500 }
      );
    }

    const { data: { publicUrl: zipUrl } } = supabase.storage
      .from('kruth-ai-assets')
      .getPublicUrl(zipPath);

    console.log('[LoRA Train] ZIP dataset URL generated:', zipUrl);

    // 3. Submit LoRA training job to Fal.ai
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY;
    if (!falKey) {
      return NextResponse.json(
        { success: false, error: 'ระบบปิดการตั้งค่าเทรนชั่วคราวเนื่องจากไม่พบ FAL_KEY' },
        { status: 500 }
      );
    }

    const requestPayload = {
      images_data_url: zipUrl,
      trigger_word: triggerWord,
      steps: steps,
      is_style: false,
    };

    console.log('[LoRA Train] Submitting training job to Fal.ai queue...');
    const falResponse = await fetch('https://queue.fal.run/fal-ai/flux-lora-fast-training', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    if (!falResponse.ok) {
      const errText = await falResponse.text();
      console.error('[LoRA Train] Fal.ai queue submission failed:', errText);
      return NextResponse.json(
        { success: false, error: 'ส่งคำขอเริ่มการเทรนไปยังระบบ AI ไม่สำเร็จ' },
        { status: 500 }
      );
    }

    const result = await falResponse.json();
    const requestId = result.request_id;
    console.log(`[LoRA Train] Job submitted successfully. Job ID: ${requestId}`);

    if (!requestId) {
      return NextResponse.json(
        { success: false, error: 'ระบบ AI ปลายทางไม่ได้ส่งคืนรหัสงานประมวลผล' },
        { status: 500 }
      );
    }

    // 4. Update Character status in Supabase DB
    const { error: dbError } = await supabase
      .from('characters')
      .update({
        lora_status: 'training',
        lora_job_id: requestId,
        lora_trigger_word: triggerWord,
        lora_dataset_url: zipUrl,
        lora_dataset_path: zipPath,
        lora_steps: steps,
        updated_at: new Date().toISOString(),
      })
      .eq('id', characterId);

    if (dbError) {
      console.error('[LoRA Train] Database update failed:', dbError);
      return NextResponse.json(
        { success: false, error: 'บันทึกสถานะโมเดลลงฐานข้อมูลล้มเหลว' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'เริ่มการเทรนเรียบร้อยแล้ว ระบบจะใช้เวลาประมวลผลประมาณ 5-10 นาที',
      jobId: requestId,
    });
  } catch (error: any) {
    console.error('[LoRA Train Error]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดในการเริ่มเทรนโมเดล' },
      { status: 500 }
    );
  }
}

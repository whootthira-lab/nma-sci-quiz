import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const characterId = searchParams.get('character_id');

    if (!characterId) {
      return NextResponse.json(
        { success: false, error: 'กรุณาระบุรหัสตัวละคร' },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Get character details from database
    const { data: character, error: dbError } = await supabase
      .from('characters')
      .select('*')
      .eq('id', characterId)
      .single();

    if (dbError || !character) {
      return NextResponse.json(
        { success: false, error: 'ไม่พบตัวละครในระบบ' },
        { status: 404 }
      );
    }

    // If status is already completed or failed, return early
    if (character.lora_status === 'completed' || character.lora_status === 'failed') {
      return NextResponse.json({
        success: true,
        status: character.lora_status,
        character,
      });
    }

    // If status is not training or no job ID, return current DB state
    if (character.lora_status !== 'training' || !character.lora_job_id) {
      return NextResponse.json({
        success: true,
        status: character.lora_status || 'not_started',
        character,
      });
    }

    const loraJobId = character.lora_job_id;
    const falKey = process.env.FAL_KEY || process.env.NEXT_PUBLIC_FAL_KEY;

    if (!falKey) {
      return NextResponse.json(
        { success: false, error: 'ไม่พบ FAL_KEY ในระบบสำหรับตรวจสอบสถานะ' },
        { status: 500 }
      );
    }

    console.log(`[LoRA Status Check] Querying status for job ID: ${loraJobId}`);

    // 2. Fetch queue status from Fal.ai
    const checkUrl = `https://queue.fal.run/fal-ai/flux-lora-fast-training/requests/${loraJobId}/status`;
    const checkResponse = await fetch(checkUrl, {
      headers: {
        'Authorization': `Key ${falKey}`,
        'Accept': 'application/json'
      },
      cache: 'no-store'
    });

    if (!checkResponse.ok) {
      console.warn(`[LoRA Status Check] Fal.ai returned status ${checkResponse.status}`);
      return NextResponse.json({
        success: true,
        status: 'training',
        message: 'กำลังตรวจสอบสถานะการเทรนจากระบบหลัก...',
        character,
      });
    }

    const statusData = await checkResponse.json();
    const currentStatus = statusData.status; // 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED'
    console.log(`[LoRA Status Check] Fal.ai Job Status: ${currentStatus}`);

    if (currentStatus === 'COMPLETED') {
      // 3. Get training output details
      const responseUrl = statusData.response_url || `https://queue.fal.run/fal-ai/flux-lora-fast-training/requests/${loraJobId}`;
      console.log(`[LoRA Status Check] Fetching training details from: ${responseUrl}`);
      
      const detailResponse = await fetch(responseUrl, {
        headers: {
          'Authorization': `Key ${falKey}`,
          'Accept': 'application/json'
        },
        cache: 'no-store'
      });

      if (!detailResponse.ok) {
        throw new Error(`ไม่สามารถเรียกดูรายละเอียดผลลัพธ์ของโมเดลได้ (status: ${detailResponse.status})`);
      }

      const detailData = await detailResponse.json();
      // Safe extraction of lora model file url
      const loraModelUrl = detailData.diffusers_lora_file?.url || detailData.weights?.url;

      if (!loraModelUrl) {
        console.error('[LoRA Status Check] No model weights URL found in detail response:', detailData);
        
        // Update database as failed
        await supabase
          .from('characters')
          .update({
            lora_status: 'failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', characterId);

        return NextResponse.json({
          success: false,
          status: 'failed',
          error: 'การเทรนเสร็จสิ้น แต่ไม่พบไฟล์โมเดลในผลลัพธ์จากระบบ AI',
        });
      }

      console.log(`[LoRA Status Check] LoRA training successful! Model weights URL: ${loraModelUrl}`);

      // 4. Update Database on success
      const { data: updatedCharacter, error: updateError } = await supabase
        .from('characters')
        .update({
          lora_status: 'completed',
          lora_model_url: loraModelUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', characterId)
        .select('*')
        .single();

      if (updateError) {
        console.error('[LoRA Status Check] Database update failed:', updateError);
        throw new Error('ไม่สามารถอัปเดตข้อมูลโมเดลตัวละครลงฐานข้อมูลได้');
      }

      return NextResponse.json({
        success: true,
        status: 'completed',
        character: updatedCharacter,
      });

    } else if (currentStatus === 'FAILED') {
      console.error(`[LoRA Status Check] Job ${loraJobId} failed at Fal.ai`);

      // Update database as failed
      const { data: updatedCharacter } = await supabase
        .from('characters')
        .update({
          lora_status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', characterId)
        .select('*')
        .single();

      return NextResponse.json({
        success: true,
        status: 'failed',
        error: 'ขั้นตอนการฝึกสอนล้มเหลวจากผู้ให้บริการประมวลผล AI',
        character: updatedCharacter,
      });
    }

    // Still in queue or in progress
    return NextResponse.json({
      success: true,
      status: 'training',
      message: currentStatus === 'IN_PROGRESS' ? 'ระบบ AI กำลังฝึกสอนโมเดลตัวละครของคุณ...' : 'งานเทรนรอในคิวประมวลผล...',
      character,
    });

  } catch (error: any) {
    console.error('[LoRA Status Check Error]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดในการตรวจสอบสถานะโมเดล' },
      { status: 500 }
    );
  }
}

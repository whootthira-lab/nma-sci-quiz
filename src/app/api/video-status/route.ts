import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { requestId, videoPath, modelType } = await req.json();
    const falKey = process.env.FAL_KEY;

    if (!requestId || !videoPath) {
      return NextResponse.json({ status: 'ERROR', error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const isCinema = modelType === 'cinema';
    const modelEndpoint = isCinema
      ? 'fal-ai/wan/image-to-video'
      : 'fal-ai/kling-video/v2.5/turbo/image-to-video';

    const checkResponse = await fetch(`https://queue.fal.run/${modelEndpoint}/requests/${requestId}`, {
      headers: {
        'Authorization': `Key ${falKey}`,
        'Accept': 'application/json'
      },
      cache: 'no-store'
    });

    if (!checkResponse.ok) {
      return NextResponse.json({ status: 'WAITING' });
    }

    const statusData = await checkResponse.json();

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (statusData.status === 'COMPLETED') {
      const tempUrl = statusData.video?.url || statusData.output?.video?.url || statusData.images?.[0]?.url;
      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      console.log(`⏳ [KRUTH Status] AI ทำงานเสร็จแล้ว! กำลังโหลดวิดีโอมาเก็บที่ Supabase...`);

      const videoRes = await fetch(tempUrl);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('kruth-ai-assets')
        .upload(videoPath, videoBuffer, {
          contentType: 'video/mp4',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`อัปโหลดวิดีโอขึ้น Supabase Storage ไม่สำเร็จ: ${uploadError.message}`);
      }

      // Get Public URL
      const { data: { publicUrl } } = supabase.storage
        .from('kruth-ai-assets')
        .getPublicUrl(videoPath);

      console.log(`✅ [KRUTH Status] บันทึกวิดีโอลง Supabase สำเร็จ! URL: ${publicUrl}`);

      // Update generation status in Supabase
      const { error: dbError } = await supabase
        .from('generations')
        .update({
          status: 'completed',
          video_url: publicUrl,
          updated_at: new Date().toISOString()
        })
        .eq('fal_request_id', requestId);

      if (dbError) {
        console.error('Failed to update generation row in Supabase:', dbError);
      }

      return NextResponse.json({ status: 'COMPLETED', videoUrl: publicUrl });

    } else if (statusData.status === 'FAILED') {
      console.error(`❌ [KRUTH Status] AI แจ้งเตือนข้อผิดพลาด:`, statusData.error);

      // Update generation status to failed in Supabase
      await supabase
        .from('generations')
        .update({
          status: 'failed',
          error_message: statusData.error || 'AI generation failed',
          updated_at: new Date().toISOString()
        })
        .eq('fal_request_id', requestId);

      return NextResponse.json({ status: 'FAILED', error: statusData.error });
    }

    return NextResponse.json({ status: statusData.status });

  } catch (error: any) {
    console.error('\n❌ [KRUTH Status Error]:', error.message);
    return NextResponse.json({ status: 'ERROR', error: error.message }, { status: 500 });
  }
}
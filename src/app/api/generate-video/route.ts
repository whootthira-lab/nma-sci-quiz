import { NextRequest, NextResponse } from 'next/server';

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

    if (statusData.status === 'COMPLETED') {
      const tempUrl = statusData.video?.url || statusData.output?.video?.url || statusData.images?.[0]?.url;
      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      console.log(`⏳ [KRUTH Status] AI ทำงานเสร็จแล้ว! กำลังโหลดวิดีโอมาเก็บที่ Firebase...`);

      const videoRes = await fetch(tempUrl);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      const { adminStorage } = await import('../../../lib/admin'); // ✅ dynamic import
      const bucket = adminStorage.bucket();
      const file = bucket.file(videoPath);

      await file.save(videoBuffer, {
        contentType: 'video/mp4',
        public: true,
        metadata: { cacheControl: 'public, max-age=31536000' }
      });

      const [finalUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });

      console.log(`✅ [KRUTH Status] บันทึกวิดีโอลง Firebase สำเร็จ!`);
      return NextResponse.json({ status: 'COMPLETED', videoUrl: finalUrl });

    } else if (statusData.status === 'FAILED') {
      console.error(`❌ [KRUTH Status] AI แจ้งเตือนข้อผิดพลาด:`, statusData.error);
      return NextResponse.json({ status: 'FAILED', error: statusData.error });
    }

    return NextResponse.json({ status: statusData.status });

  } catch (error: any) {
    console.error('\n❌ [KRUTH Status Error]:', error.message);
    return NextResponse.json({ status: 'ERROR', error: error.message }, { status: 500 });
  }
}
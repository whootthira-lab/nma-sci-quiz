import { NextRequest, NextResponse } from 'next/server';
import { adminStorage } from '../../../lib/admin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { requestId, videoPath, modelType } = await req.json();
    const falKey = process.env.FAL_KEY;

    if (!requestId || !videoPath) {
      return NextResponse.json({ status: 'ERROR', error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    // 🕵️ เช็กว่าหน้าเว็บสั่งให้เช็กงานจากโมเดลไหน
    const isCinema = modelType === 'cinema';
    const modelEndpoint = isCinema 
      ? 'fal-ai/wan/image-to-video' 
      : 'fal-ai/kling-video/v2.5/turbo/image-to-video';

    // 1. ทักไปถามสถานะจาก Fal.ai 1 ครั้ง (ไม่ต้องวนลูป)
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

    // 2. ถ้าสถานะคือ "เสร็จสมบูรณ์" (COMPLETED) ให้ดูดไฟล์ทันที
    if (statusData.status === 'COMPLETED') {
      const tempUrl = statusData.video?.url || statusData.output?.video?.url || statusData.images?.[0]?.url;

      if (!tempUrl) throw new Error('ไม่พบ URL วิดีโอจากระบบ AI');

      console.log(`\n⏳ [KRUTH Status] AI ทำงานเสร็จแล้ว! กำลังโหลดวิดีโอมาเก็บที่ Firebase...`);

      // ดูดไฟล์จาก Fal.ai มาเก็บไว้ในเครื่องชั่วคราว
      const videoRes = await fetch(tempUrl);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // โยนขึ้น Firebase Storage ของเรา
      const bucket = adminStorage.bucket();
      const file = bucket.file(videoPath);
      await file.save(videoBuffer, {
        contentType: 'video/mp4',
        public: true,
        metadata: { cacheControl: 'public, max-age=31536000' }
      });

      // ดึงลิงก์ Firebase แบบถาวรกลับไปให้หน้าเว็บ
      const [finalUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });

      console.log(`✅ [KRUTH Status] บันทึกวิดีโอลง Firebase สำเร็จ! โยนลิงก์ให้หน้าเว็บ`);
      return NextResponse.json({ status: 'COMPLETED', videoUrl: finalUrl });
    } 
    
    // ถ้า AI แจ้งว่าล้มเหลว
    else if (statusData.status === 'FAILED') {
      console.error(`❌ [KRUTH Status] AI แจ้งเตือนข้อผิดพลาด:`, statusData.error);
      return NextResponse.json({ status: 'FAILED', error: statusData.error });
    }

    // 3. ถ้ายังไม่เสร็จ (IN_QUEUE, IN_PROGRESS) ก็แค่ส่งสถานะกลับไปบอกหน้าเว็บให้อัปเดต UI
    return NextResponse.json({ status: statusData.status });

  } catch (error: any) {
    console.error('\n❌ [KRUTH Status Error]:', error.message);
    return NextResponse.json({ status: 'ERROR', error: error.message }, { status: 500 });
  }
}
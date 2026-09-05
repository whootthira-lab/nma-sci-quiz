import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { falSubmit, falStatus, falResult, FalSubmitError, normalizeOutput } from '@/lib/providers/fal';
import { assertRunnable, estimateCost } from '@/lib/providers/registry';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * VFX Phase 0.5 — "เปลี่ยนฉากหลังวิดีโอ", one mode, no layer UI yet.
 *
 * Two engines, both proved on 4 ก.ย. with real bills:
 *  - matte  : veed background removal (h264 mode → an RGB clip + an alpha clip) at $0.012/s,
 *             then video-status composites the person onto the new background with ffmpeg
 *             (alphamerge + overlay — filters the 2018 build on Vercel has) and grades it.
 *  - o3     : Kling O3 Pro video edit at $0.163/s re-renders the shot with the new
 *             environment, taking the background image as @Image1. Best lighting match,
 *             3–15 s clips only (the model's own limit).
 *
 * The new background is either an image the user uploaded or one generated here from a
 * prompt (Flux Dev, ~$0.03) at the footage's aspect. This route spends nothing on video
 * until the audio-free part — permission, footage limits, credits — has passed, and it
 * leaves a generations row shaped so video-status carries the job to storage on its own.
 */

const MATTE_ID = 'matte-veed-fast';
const O3_EDIT_ID = 'vedit-o3';
const BG_IMAGE_ID = 'flux-dev';
const MATTE_MAX_SECONDS = 30; // composite must finish inside the 300 s function cap
const O3_MIN_SECONDS = 3;
const O3_MAX_SECONDS = 15;
const BG_IMAGE_CREDITS = 3; // ≈1 MP of Flux Dev, shown credits

export type Grade = 'none' | 'warm' | 'cool' | 'cinematic';
const GRADES: Grade[] = ['none', 'warm', 'cool', 'cinematic'];

function bgSize(w: number, h: number) {
  // Flux takes a fixed menu; pick the one closest to the footage's aspect
  const r = w && h ? w / h : 16 / 9;
  if (r > 1.6) return 'landscape_16_9';
  if (r > 1.1) return 'landscape_4_3';
  if (r > 0.9) return 'square_hd';
  if (r > 0.65) return 'portrait_4_3';
  return 'portrait_16_9';
}

async function generateBackground(prompt: string, size: string): Promise<string> {
  const model = assertRunnable(BG_IMAGE_ID);
  const { requestId } = await falSubmit(model.endpoint, {
    prompt: `${prompt}. Empty environment with no people, photographic, cinematic lighting, high detail, wide establishing framing`,
    image_size: size,
    num_images: 1,
    enable_safety_checker: true
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await falStatus(model.endpoint, requestId);
    if (st.status === 'COMPLETED') {
      const res = await falResult(model.endpoint, requestId);
      if (!res.ok) throw new Error(`สร้างภาพฉากหลังไม่สำเร็จ (HTTP ${res.httpStatus})`);
      const { url } = normalizeOutput(res.data);
      if (!url) throw new Error('สร้างภาพฉากหลังไม่สำเร็จ (ไม่มีไฟล์ภาพกลับมา)');
      return url;
    }
    if (st.status === 'FAILED') throw new Error('สร้างภาพฉากหลังไม่สำเร็จ (โมเดลรายงานล้มเหลว)');
  }
  throw new Error('สร้างภาพฉากหลังนานเกินกำหนด กรุณาลองใหม่');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userEmail: string = (body.user_email || '').trim().toLowerCase();
    const userId: string = body.user_id || '';
    const footageUrl: string = body.footage_url || '';
    const footageSeconds = Number(body.footage_seconds) || 0;
    const footageW = Number(body.footage_width) || 0;
    const footageH = Number(body.footage_height) || 0;
    const engine: 'matte' | 'o3' = body.engine === 'o3' ? 'o3' : 'matte';
    const grade: Grade = GRADES.includes(body.grade) ? body.grade : 'none';
    let backgroundUrl: string = body.background_image_url || '';
    const backgroundPrompt: string = (body.background_prompt || '').trim();

    if (!userEmail || !footageUrl || !footageSeconds) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบ: ต้องมีฟุตเทจ (อัปโหลดแล้ว) และความยาวคลิป' }, { status: 400 });
    }
    if (!backgroundUrl && !backgroundPrompt) {
      return NextResponse.json({ success: false, error: 'ระบุฉากหลังใหม่: อัปโหลดภาพ หรือบรรยายฉากให้ระบบสร้าง' }, { status: 400 });
    }
    if (engine === 'matte' && footageSeconds > MATTE_MAX_SECONDS) {
      return NextResponse.json({ success: false, error: `โหมดตัดคน+วางฉากรับฟุตเทจไม่เกิน ${MATTE_MAX_SECONDS} วินาทีต่อคลิป (ตัดฟุตเทจเป็นช่วงก่อน)` }, { status: 400 });
    }
    if (engine === 'o3' && (footageSeconds < O3_MIN_SECONDS || footageSeconds > O3_MAX_SECONDS)) {
      return NextResponse.json({ success: false, error: `Kling O3 Edit รับฟุตเทจ ${O3_MIN_SECONDS}–${O3_MAX_SECONDS} วินาทีเท่านั้น` }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── permission (a failed lookup is not a verdict)
    const isSuperAdmin = userEmail === 'whootthira@gmail.com';
    let whitelistUser: any = null;
    let lookupFailed = false;
    try {
      const { data, error } = await supabase.from('whitelist').select('generation_limit, expires_at').eq('email', userEmail).maybeSingle();
      if (error) throw error;
      whitelistUser = data;
    } catch (e) {
      lookupFailed = true;
      console.warn('[VFX] whitelist lookup failed:', e);
    }
    if (!isSuperAdmin) {
      if (lookupFailed) return NextResponse.json({ success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ กรุณากดสร้างใหม่อีกครั้ง (สิทธิ์ของคุณไม่ได้ถูกเพิกถอน)' }, { status: 503 });
      if (!whitelistUser) return NextResponse.json({ success: false, error: 'ขออภัย บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาตให้ใช้งาน (Not Whitelisted)' }, { status: 403 });
      if (whitelistUser.expires_at && new Date(whitelistUser.expires_at).getTime() < Date.now()) {
        return NextResponse.json({ success: false, error: 'ขออภัย สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบ' }, { status: 403 });
      }
    }

    // ── price from the registry (bill-verified rates), checked before anything is spent
    const model = assertRunnable(engine === 'o3' ? O3_EDIT_ID : MATTE_ID);
    const secs = Math.ceil(footageSeconds);
    const videoCredits = estimateCost(model.id, secs).creditsShown;
    const creditsShown = videoCredits + (backgroundUrl ? 0 : BG_IMAGE_CREDITS) + 1;
    const cost = creditsShown * 10;
    const userCredits = isSuperAdmin ? 999999 : (whitelistUser?.generation_limit || 0);
    if (!isSuperAdmin && userCredits < cost) {
      return NextResponse.json({ success: false, error: `เครดิตไม่พอ (ต้องการ ${creditsShown} เครดิต, คงเหลือ ${(userCredits / 10).toFixed(1).replace('.0', '')} เครดิต)` }, { status: 403 });
    }

    // ── the new background
    if (!backgroundUrl) {
      backgroundUrl = await generateBackground(backgroundPrompt, bgSize(footageW, footageH));
    }

    // ── the video job
    let requestId = '';
    let prompt = '';
    try {
      if (engine === 'o3') {
        const where = backgroundPrompt || 'the environment shown in @Image1';
        prompt = `Replace the entire background and environment of @Video1 with ${where}${backgroundUrl ? ', matching the look of @Image1' : ''}. Keep the person, their face, clothing, motion, timing and camera framing exactly as in @Video1. Relight the person naturally to match the new environment. No text, no extra people.`;
        const sub = await falSubmit(model.endpoint, {
          video_url: footageUrl,
          prompt,
          image_urls: [backgroundUrl],
          keep_audio: true
        });
        requestId = sub.requestId;
      } else {
        prompt = `background replacement: ${backgroundPrompt || 'uploaded image'}`;
        const sub = await falSubmit(model.endpoint, {
          video_url: footageUrl,
          output_codec: 'h264', // RGB clip + alpha clip — what the old ffmpeg can composite
          subject_is_person: true,
          refine_foreground_edges: true
        });
        requestId = sub.requestId;
      }
    } catch (e: any) {
      if (e instanceof FalSubmitError) {
        if (e.isBalanceLock) throw new Error('บัญชี Fal.ai ของระบบยอดเงินหมด/ถูกล็อก — แจ้งผู้ดูแลระบบให้เติมเงิน');
        throw new Error(`ส่งงานไปยัง Fal.ai ไม่สำเร็จ (HTTP ${e.httpStatus}: ${e.detail})`);
      }
      throw e;
    }

    // ── the record video-status carries to storage (matte engine: it also composites)
    const timestamp = Date.now();
    let finalUserId = userId;
    if (!finalUserId) {
      const { data: profile } = await supabase.from('profiles').select('id').eq('email', userEmail).maybeSingle();
      finalUserId = profile?.id || '';
    }
    const videoPath = `videos/${userEmail}/${timestamp}_vfx.mp4`;
    if (finalUserId) {
      await supabase.from('generations').insert({
        user_id: finalUserId,
        prompt,
        source_image_url: backgroundUrl,
        status: 'processing',
        fal_request_id: requestId,
        metadata: {
          mode: 'vfx-background',
          situation_prompt: backgroundPrompt,
          model_endpoint: model.endpoint,
          model_name: model.id,
          is_no_speech: true,
          narration_only: false,
          avatar_mode: false,
          ambient_pending: false,
          storage_path: videoPath,
          storage_provider: 'supabase',
          api_provider: 'fal',
          duration_estimate: secs,
          vfx_engine: engine,
          vfx_footage_url: footageUrl,
          vfx_background_url: backgroundUrl,
          vfx_grade: grade,
          vfx_width: footageW,
          vfx_height: footageH,
          credits_charged: creditsShown
        }
      });
    }

    if (!isSuperAdmin && whitelistUser) {
      const newCredits = Math.max(0, (whitelistUser.generation_limit || 0) - cost);
      await supabase.from('whitelist').update({ generation_limit: newCredits }).eq('email', userEmail);
    }

    return NextResponse.json({
      success: true,
      requestId,
      videoPath,
      modelEndpoint: model.endpoint,
      engine,
      backgroundUrl,
      credits: creditsShown
    });
  } catch (error: any) {
    console.error('[VFX Background]', error);
    return NextResponse.json({ success: false, error: error?.message || 'เปลี่ยนฉากหลังไม่สำเร็จ' }, { status: 500 });
  }
}

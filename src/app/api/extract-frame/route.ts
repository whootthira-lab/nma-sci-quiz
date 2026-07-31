import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Grabs the final frame of a clip so it can seed the next one, which keeps a
 * character's pose continuous across two separately generated clips.
 */
export async function POST(req: NextRequest) {
  const tempFiles: string[] = [];
  try {
    const { videoUrl, user_email } = await req.json();
    if (!videoUrl || !user_email) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลไม่ครบถ้วน (ต้องระบุ videoUrl และ user_email)' },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    const stamp = Date.now();
    const dir = path.join(os.tmpdir(), `kruth-frame-${stamp}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const localVideo = path.join(dir, 'clip.mp4');
    const localFrame = path.join(dir, 'last.png');
    tempFiles.push(localVideo, localFrame);

    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`ดาวน์โหลดคลิปไม่สำเร็จ: ${res.statusText}`);
    await fs.promises.writeFile(localVideo, Buffer.from(await res.arrayBuffer()));

    // -sseof seeks relative to the end, so this lands on the last rendered frame
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegInstaller.path,
        ['-y', '-sseof', '-0.3', '-i', localVideo, '-frames:v', '1', '-q:v', '2', localFrame],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const buffer = await fs.promises.readFile(localFrame);
    const storagePath = `continuity/${user_email}/${stamp}_lastframe.png`;
    const { error: uploadError } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });
    if (uploadError) throw new Error(`อัปโหลดเฟรมไม่สำเร็จ: ${uploadError.message}`);

    const {
      data: { publicUrl }
    } = supabase.storage.from('kruth-ai-assets').getPublicUrl(storagePath);

    return NextResponse.json({ success: true, imageUrl: publicUrl, storagePath });
  } catch (error: any) {
    console.error('[Extract Frame API]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'ดึงเฟรมสุดท้ายไม่สำเร็จ' },
      { status: 500 }
    );
  } finally {
    for (const f of tempFiles) {
      try {
        await fs.promises.unlink(f);
      } catch {
        /* already gone */
      }
    }
  }
}

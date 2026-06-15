import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Configure ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300; // 5 minutes max duration
export const dynamic = 'force-dynamic';

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`[Merge API] Downloading temporary video file from: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ดาวน์โหลดไฟล์วิดีโอจาก URL ไม่สำเร็จ: ${response.statusText} (${url})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.promises.writeFile(destPath, buffer);
}

export async function POST(req: NextRequest) {
  const tempFiles: string[] = [];
  let tempDir = '';

  try {
    const body = await req.json();
    const { videoUrls, user_email, user_id, title, aspectRatio, baseImageUrl, faceTags } = body;

    // Validate payload
    if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length < 2) {
      return NextResponse.json(
        { success: false, error: 'กรุณาส่งรายการ URL วิดีโอเพื่อทำการรวมอย่างน้อย 2 รายการ' },
        { status: 400 }
      );
    }
    if (!user_email || !user_id) {
      return NextResponse.json(
        { success: false, error: 'ข้อมูลผู้ใช้ไม่ถูกต้อง (กรุณาระบุ user_email และ user_id)' },
        { status: 400 }
      );
    }

    console.log(`[Merge API] Starting merge task for user: ${user_email}. Number of clips: ${videoUrls.length}`);

    // Create unique temp directory
    const timestamp = Date.now();
    tempDir = path.join(os.tmpdir(), `kruth-merge-${timestamp}-${Math.random().toString(36).substring(2, 7)}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // 1. Download all clips sequentially
    const localVideoPaths: string[] = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const videoUrl = videoUrls[i];
      const localPath = path.join(tempDir, `clip_${i}.mp4`);
      await downloadFile(videoUrl, localPath);
      localVideoPaths.push(localPath);
      tempFiles.push(localPath);
    }

    // 2. Write concat.txt for FFmpeg concat demuxer
    // Note: Use forward slashes inside concat.txt even on Windows to prevent path parsing issues
    const concatTxtContent = localVideoPaths
      .map(p => `file '${p.replace(/\\/g, '/')}'`)
      .join('\n');
    const concatTxtPath = path.join(tempDir, 'concat_list.txt');
    await fs.promises.writeFile(concatTxtPath, concatTxtContent, 'utf-8');
    tempFiles.push(concatTxtPath);

    console.log(`[Merge API] Created concat list file at: ${concatTxtPath}`);
    console.log(concatTxtContent);

    // 3. Perform FFmpeg merge using concat demuxer (-c copy is instant and loss-less)
    const outputPath = path.join(tempDir, 'merged_output.mp4');
    tempFiles.push(outputPath);

    console.log(`[Merge API] Running FFmpeg concat process...`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatTxtPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions('-c copy')
        .save(outputPath)
        .on('start', (commandLine) => {
          console.log(`[Merge API] FFmpeg Command: ${commandLine}`);
        })
        .on('end', () => {
          console.log(`[Merge API] FFmpeg concat successfully finished.`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[Merge API] FFmpeg concat error:`, err);
          reject(new Error(`การรวมไฟล์วิดีโอด้วย FFmpeg ล้มเหลว: ${err.message}`));
        });
    });

    // 4. Read output file buffer
    const mergedBuffer = await fs.promises.readFile(outputPath);
    console.log(`[Merge API] Merged video size: ${mergedBuffer.length} bytes`);

    // 5. Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Upload to Supabase Storage
    const storagePath = `videos/${user_email}/${timestamp}_merged.mp4`;
    console.log(`[Merge API] Uploading merged video to Supabase Storage: ${storagePath}`);
    
    const { error: uploadError } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(storagePath, mergedBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`อัปโหลดไฟล์วิดีโอที่รวมเสร็จแล้วขึ้น Supabase Storage ไม่สำเร็จ: ${uploadError.message}`);
    }

    // Get Public URL
    const { data: { publicUrl } } = supabase.storage
      .from('kruth-ai-assets')
      .getPublicUrl(storagePath);
    console.log(`[Merge API] Uploaded successfully. Public URL: ${publicUrl}`);

    // Ensure profiles table has a row for this user
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user_id)
        .single();
      
      if (!profile) {
        console.log(`[Merge API] Creating missing profile row for user: ${user_id}`);
        await supabase
          .from('profiles')
          .insert({
            id: user_id,
            email: user_email,
            role: user_email === 'whootthira@gmail.com' ? 'admin' : 'user'
          });
      }
    } catch (e) {
      console.warn('[Merge API] Error verifying profile:', e);
    }

    // 6. Log generation record in DB
    const finalTitle = title || `คลิปบทสนทนารวม ${videoUrls.length} ประโยค`;
    const { error: dbError } = await supabase
      .from('generations')
      .insert({
        user_id: user_id,
        prompt: finalTitle,
        audio_prompt: null,
        source_image_url: '',
        status: 'completed',
        video_url: publicUrl,
        metadata: {
          mode: 'dialogue-merged',
          title: finalTitle,
          video_urls: videoUrls,
          aspect_ratio: aspectRatio || '16:9',
          storage_path: storagePath,
          duration_estimate: 0,
          base_image_url: baseImageUrl || null,
          face_tags: faceTags || null
        }
      });

    if (dbError) {
      console.error('[Merge API] Error inserting generation record to Supabase:', dbError);
    }

    return NextResponse.json({
      success: true,
      videoUrl: publicUrl,
      storagePath
    });

  } catch (error: any) {
    console.error(`[Merge API Exception]:`, error.message || error);
    return NextResponse.json(
      { success: false, error: error.message || 'เกิดข้อผิดพลาดภายในระบบสำหรับการรวมวิดีโอ' },
      { status: 500 }
    );
  } finally {
    // 7. Cleanup temp files and temp directory
    console.log(`[Merge API] Cleaning up temporary files...`);
    for (const filePath of tempFiles) {
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch (e) {
        console.warn(`[Merge API] Failed to delete temp file: ${filePath}`, e);
      }
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        await fs.promises.rmdir(tempDir);
      } catch (e) {
        console.warn(`[Merge API] Failed to delete temp directory: ${tempDir}`, e);
      }
    }
  }
}

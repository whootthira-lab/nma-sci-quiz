import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { falSubmit, FalSubmitError } from '@/lib/providers/fal';
import { padSpeechWithSilence, generateTTS, generateGeminiTTS, generateGoogleTTS, generateOpenAITTS, generateCosyVoiceTTS } from '@/lib/tts';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Scene Beat — several consecutive dialogue lines, two characters, ONE continuous shot.
 *
 * Proved 5 ก.ย.: Kling O3 reference-to-video takes the cast as @Image1/@Image2 and a
 * prompt that scripts the turn-taking; it stages who speaks and who listens. The finished
 * two-shot then goes through the same lip-sync phase every speech clip does, driven by the
 * lines' voices concatenated into one track — and the lip-sync moves only the mouth of
 * whoever is speaking in each segment. So this route only has to: speak every line,
 * string the audio together, write the stage directions, and submit. The generation row
 * it leaves behind is shaped like any other speech clip, so video-status carries it the
 * rest of the way (lip-sync → 0.25s shift → storage) with no new phase logic.
 *
 * O3 caps a shot at 15 s, so the audio is measured and refused if it does not fit —
 * the client groups lines conservatively and re-groups on that refusal.
 */

const BEAT_ENDPOINT = 'fal-ai/kling-video/o3/standard/reference-to-video';
const BEAT_MAX_SECONDS = 15;
const BEAT_RATE_PER_SEC = 10; // Kling O3 standard, billed $0.084/s
const LIPSYNC_RATE_PER_SEC = 2; // Kling lip-sync, billed $0.014/s

interface BeatLine {
  speaker: number; // index into characters
  text: string;
  voice_id: string;
  tts_provider: 'google' | 'openai' | 'cosyvoice' | 'gemini' | 'botnoi';
  emotion_instruction?: string;
  emotion_label?: string;
  speed?: number;
  /** an uploaded recording for this line (storage URL) — used instead of TTS */
  audio_url?: string;
}
interface BeatCharacter {
  name: string;
  image_url: string;
  description?: string;
}

function probeSeconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = require('child_process').spawn(ffmpegInstaller.path, ['-i', file]);
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
      resolve(m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0);
    });
  });
}

async function speak(line: BeatLine): Promise<Buffer> {
  // A card with its own recording skips TTS: the file was uploaded by the browser straight
  // to storage and arrives here as a URL (never as bytes through this function).
  if (line.audio_url) {
    const res = await fetch(line.audio_url);
    if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์เสียงที่อัปโหลดไม่สำเร็จ (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  const speed = line.speed || 1.0;
  switch (line.tts_provider) {
    case 'gemini': return generateGeminiTTS(line.text, line.voice_id, speed, line.emotion_instruction || '');
    case 'google': return generateGoogleTTS(line.text, line.voice_id, speed);
    case 'openai': return generateOpenAITTS(line.text, line.voice_id, speed);
    case 'cosyvoice': return generateCosyVoiceTTS(line.text, line.voice_id, speed);
    default: return generateTTS(line.text, line.voice_id, speed);
  }
}

/** Stage directions O3 follows: who is in frame, who speaks in what order, who listens. */
function stageDirections(characters: BeatCharacter[], lines: BeatLine[], secs: number[], situation: string): string {
  const who = (i: number) => `@Image${i + 1} (${characters[i]?.name || 'character ' + (i + 1)})`;
  const cast = characters.map((c, i) => `${who(i)}${c.description ? ': ' + c.description : ''}`).join('; ');
  const turns = lines.map((l, i) => {
    const listeners = characters.map((_, ci) => ci).filter((ci) => ci !== l.speaker).map(who).join(' and ');
    const mood = l.emotion_label ? `, ${l.emotion_label}` : '';
    return `Turn ${i + 1} (about ${Math.round(secs[i])} seconds): ${who(l.speaker)} speaks${mood} — the only person talking; ${listeners} listen${listeners.includes(' and ') ? '' : 's'}, reacting naturally with nods and eye contact but lips closed.`;
  }).join(' ');
  const setting = situation ? `Setting: ${situation}. ` : '';
  const sceneRef = characters.length < 3 ? '' : ` The location matches @Image${characters.length}.`;
  return (
    `${setting}Medium two-shot, steady camera, no cuts. Cast: ${cast}. Everyone stays fully visible in frame the whole time, standing naturally together.${sceneRef} ` +
    `${turns} Only the current speaker moves their lips; everyone else keeps lips closed while listening. Natural hand gestures and expressive faces, cinematic lighting.`
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userEmail: string = (body.user_email || '').trim().toLowerCase();
    const userId: string = body.user_id || '';
    const aspectRatio: string = ['16:9', '9:16', '1:1'].includes(body.aspect_ratio) ? body.aspect_ratio : '16:9';
    const characters: BeatCharacter[] = Array.isArray(body.characters) ? body.characters : [];
    const lines: BeatLine[] = Array.isArray(body.lines) ? body.lines : [];
    const sceneName: string = body.scene_name || '';
    const sceneImageUrl: string = body.scene_image_url || '';
    const situation: string = body.situation_prompt || '';

    if (!userEmail || characters.length < 1 || lines.length < 1) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบ: ต้องมีตัวละครอย่างน้อย 1 คนและบทพูดอย่างน้อย 1 บรรทัด' }, { status: 400 });
    }
    if (characters.length > 3 || lines.length > 8) {
      return NextResponse.json({ success: false, error: 'บีตหนึ่งรองรับตัวละครไม่เกิน 3 คน และบทพูดไม่เกิน 8 บรรทัด' }, { status: 400 });
    }
    if (characters.some((c) => !c.image_url) || lines.some((l) => (!l.text?.trim() && !l.audio_url) || l.speaker < 0 || l.speaker >= characters.length)) {
      return NextResponse.json({ success: false, error: 'ตัวละครทุกคนต้องมีรูป และทุกบรรทัดต้องระบุผู้พูดกับข้อความ' }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── permission (same rule as every other route: a failed lookup is not a verdict)
    const isSuperAdmin = userEmail === 'whootthira@gmail.com';
    let whitelistUser: any = null;
    let lookupFailed = false;
    try {
      const { data, error } = await supabase.from('whitelist').select('generation_limit, expires_at').eq('email', userEmail).maybeSingle();
      if (error) throw error;
      whitelistUser = data;
    } catch (e) {
      lookupFailed = true;
      console.warn('[Beat] whitelist lookup failed:', e);
    }
    if (!isSuperAdmin) {
      if (lookupFailed) return NextResponse.json({ success: false, error: 'ระบบตรวจสอบสิทธิ์ขัดข้องชั่วขณะ กรุณากดสร้างใหม่อีกครั้ง (สิทธิ์ของคุณไม่ได้ถูกเพิกถอน)' }, { status: 503 });
      if (!whitelistUser) return NextResponse.json({ success: false, error: 'ขออภัย บัญชีของคุณไม่อยู่ในรายชื่อผู้ได้รับอนุญาตให้ใช้งาน (Not Whitelisted)' }, { status: 403 });
      if (whitelistUser.expires_at && new Date(whitelistUser.expires_at).getTime() < Date.now()) {
        return NextResponse.json({ success: false, error: 'ขออภัย สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบ' }, { status: 403 });
      }
    }

    // ── speak every line, pad, measure, and string them into one track
    const timestamp = Date.now();
    const dir = os.tmpdir();
    const parts: string[] = [];
    const secs: number[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        const raw = await speak(lines[i]);
        const padded = await padSpeechWithSilence(raw, `beat${i}`);
        const f = path.join(dir, `beat_${timestamp}_${i}.mp3`);
        fs.writeFileSync(f, padded);
        parts.push(f);
        secs.push(await probeSeconds(f));
      }
      const total = secs.reduce((a, b) => a + b, 0);
      if (total > BEAT_MAX_SECONDS) {
        return NextResponse.json({
          success: false,
          error: `บีตนี้ยาว ${total.toFixed(1)} วินาที เกินเพดาน ${BEAT_MAX_SECONDS} วินาทีของ Kling O3 — แบ่งบทพูดออกเป็นบีตย่อยลง`,
          measured_seconds: secs
        }, { status: 400 });
      }

      const listFile = path.join(dir, `beat_${timestamp}.txt`);
      fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'));
      const beatFile = path.join(dir, `beat_${timestamp}.mp3`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c:a libmp3lame', '-b:a 128k', '-ar 44100'])
          .on('end', () => resolve()).on('error', (e: any) => reject(e)).save(beatFile);
      });
      const beatBuffer = fs.readFileSync(beatFile);
      const duration = Math.min(BEAT_MAX_SECONDS, Math.max(3, Math.ceil(total)));

      // ── credits: measured seconds decide the price, checked before any money is spent on video
      const cost = ((BEAT_RATE_PER_SEC + LIPSYNC_RATE_PER_SEC) * duration + 1) * 10;
      const userCredits = isSuperAdmin ? 999999 : (whitelistUser?.generation_limit || 0);
      if (!isSuperAdmin && userCredits < cost) {
        return NextResponse.json({ success: false, error: `เครดิตไม่พอสำหรับบีตนี้ (ต้องการ ${cost / 10} เครดิต, คงเหลือ ${(userCredits / 10).toFixed(1).replace('.0', '')} เครดิต)` }, { status: 403 });
      }

      const audioPath = `audio/${userEmail}/${timestamp}_beat.mp3`;
      const { error: upErr } = await supabase.storage.from('kruth-ai-assets').upload(audioPath, beatBuffer, { contentType: 'audio/mpeg', upsert: true });
      if (upErr) throw new Error('อัปโหลดเสียงบีตไม่สำเร็จ: ' + upErr.message);
      const audioUrl = supabase.storage.from('kruth-ai-assets').getPublicUrl(audioPath).data.publicUrl;

      // ── the shot
      const imageUrls = characters.map((c) => c.image_url);
      if (sceneImageUrl && imageUrls.length < 3) imageUrls.push(sceneImageUrl);
      const prompt = stageDirections(characters, lines, secs, situation);
      let requestId = '';
      try {
        const sub = await falSubmit(BEAT_ENDPOINT, {
          image_urls: imageUrls,
          prompt,
          duration: String(duration),
          aspect_ratio: aspectRatio,
          generate_audio: false
        });
        requestId = sub.requestId;
      } catch (e: any) {
        if (e instanceof FalSubmitError) {
          if (e.isBalanceLock) throw new Error('บัญชี Fal.ai ของระบบยอดเงินหมด/ถูกล็อก — แจ้งผู้ดูแลระบบให้เติมเงิน');
          throw new Error(`ส่งงานสร้างบีตไปยัง Fal.ai ไม่สำเร็จ (HTTP ${e.httpStatus}: ${e.detail})`);
        }
        throw e;
      }

      // ── the record video-status will carry through lip-sync and storage
      let finalUserId = userId;
      if (!finalUserId) {
        const { data: profile } = await supabase.from('profiles').select('id').eq('email', userEmail).maybeSingle();
        finalUserId = profile?.id || '';
      }
      const videoPath = `videos/${userEmail}/${timestamp}_beat.mp4`;
      if (finalUserId) {
        await supabase.from('generations').insert({
          user_id: finalUserId,
          prompt,
          audio_prompt: audioUrl,
          source_image_url: imageUrls[0],
          status: 'processing',
          fal_request_id: requestId,
          metadata: {
            mode: 'dialogue-beat',
            scene: sceneName,
            script_text: lines.map((l) => `${characters[l.speaker]?.name || ''}: ${l.text}`).join('\n'),
            situation_prompt: situation,
            model_endpoint: BEAT_ENDPOINT,
            model_name: 'kling-o3-reference',
            is_no_speech: false,
            narration_only: false,
            avatar_mode: false,
            ambient_pending: false,
            storage_path: videoPath,
            audio_path: audioPath,
            storage_provider: 'supabase',
            api_provider: 'fal',
            aspect_ratio: aspectRatio,
            duration_estimate: duration,
            beat_lines: lines.map((l, i) => ({ speaker: l.speaker, text: l.text, seconds: +secs[i].toFixed(2) }))
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
        modelEndpoint: BEAT_ENDPOINT,
        durationSecs: duration,
        measured_seconds: secs,
        credits: cost / 10
      });
    } finally {
      for (const f of parts) { try { fs.unlinkSync(f); } catch { /* gone */ } }
      for (const f of [path.join(dir, `beat_${timestamp}.txt`), path.join(dir, `beat_${timestamp}.mp3`)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    }
  } catch (error: any) {
    console.error('[Beat]', error);
    return NextResponse.json({ success: false, error: error?.message || 'สร้างบีตไม่สำเร็จ' }, { status: 500 });
  }
}

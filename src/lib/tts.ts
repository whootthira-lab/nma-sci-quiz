import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Every voice the platform can speak with, and the silence padding they all get. Lifted
 * out of generate-video so the dialogue beat route can speak the same lines the same way.
 */

/**
 * One second of silence before the first word and after the last. The clip length already
 * reserves this (+2s in the auto duration), but the speech itself always started at 0:00,
 * so every video opened mid-breath — the lip-sync places audio exactly where it sits in
 * the file, which makes the file the one honest place to put the pause. Runs on every
 * voice source alike (all four TTS vendors and uploaded files); output is normalised MP3.
 * If padding fails the original audio is used — a clip without the pause beats no clip.
 */
export async function padSpeechWithSilence(input: Buffer, tag: string): Promise<Buffer> {
  const dir = os.tmpdir();
  const inPath = path.join(dir, `pad_in_${tag}_${Date.now()}`);
  const outPath = path.join(dir, `pad_out_${tag}_${Date.now()}.mp3`);
  try {
    fs.writeFileSync(inPath, input);
    await new Promise<void>((resolve, reject) => {
      // The deployed linux ffmpeg is a 2018 static build (verified via the diag endpoint:
      // N-47683), which predates adelay's all=1 AND apad's pad_dur — both failed there
      // through the silent fallback, so production clips shipped unpadded while local
      // (darwin 4.4) tests passed. This chain sticks to options that old build has:
      // fold to mono, fix the rate, delay the (single) channel, pad a rate's worth of
      // samples at the tail.
      ffmpeg(inPath)
        .audioFilters(['aformat=channel_layouts=mono', 'aresample=44100', 'adelay=1000', 'apad=pad_len=44100'])
        .outputOptions(['-c:a libmp3lame', '-b:a 128k', '-ar 44100'])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(outPath);
    });
    return fs.readFileSync(outPath);
  } catch (err) {
    console.warn('[Audio Pad] Failed to pad speech, using unpadded audio:', err);
    return input;
  } finally {
    for (const p of [inPath, outPath]) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }
}


export async function generateTTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const botnoiToken = process.env.BOTNOI_TOKEN;
  if (!botnoiToken) throw new Error('ไม่พบ BOTNOI_TOKEN ในระบบ');

  const voiceMap: Record<string, string> = {
    'ava': '1',
    'jaidee': '2',
    'kacha': '3',
    'te': '4'
  };
  const speakerId = voiceMap[voiceId] || voiceId;

  console.log(`[Botnoi] Generating Thai TTS audio for speaker ID: ${speakerId} with speed factor: ${speedFactor}`);

  const botnoiResponse = await fetch('https://api-voice.botnoi.ai/api/service/generate_audio', {
    method: 'POST',
    headers: {
      'Botnoi-Token': botnoiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text,
      speaker: speakerId,
      volume: 1,
      speed: speedFactor,
      type_media: 'mp3'
    }),
  });

  if (!botnoiResponse.ok) {
    let errorText = '';
    try {
      errorText = await botnoiResponse.text();
      const errorJson = JSON.parse(errorText);
      if (errorJson && errorJson.message) {
        throw new Error(`Botnoi TTS API failed: ${errorJson.message} (กรุณาเติมเครดิต Botnoi หรือติดต่อผู้ดูแลระบบ)`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Botnoi TTS API failed:')) {
        throw e;
      }
    }
    throw new Error(`Botnoi TTS API failed with status ${botnoiResponse.status}${errorText ? ` - ${errorText}` : ''}`);
  }

  const data = await botnoiResponse.json();

  if (!data.audio_url) {
    throw new Error('Botnoi did not return audio_url');
  }

  const audioFetch = await fetch(data.audio_url);
  if (!audioFetch.ok) {
    throw new Error('Failed to fetch audio file from Botnoi url');
  }

  const arrayBuffer = await audioFetch.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Gemini TTS: the whole point over the Cloud voices is that tone is steerable with plain
 * Thai ("พูดอย่างอบอุ่น...") — the emotion arrives as an instruction prefixed to the text.
 * The model answers raw PCM (s16le mono 24kHz), converted here to the MP3 the rest of the
 * pipeline expects. Speed has no parameter either, so a large deviation is asked for in
 * words; small ones are left alone rather than fought over.
 */
export async function generateGeminiTTS(text: string, voiceId: string, speedFactor: number = 1.0, emotionInstruction: string = ''): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  if (!apiKey) throw new Error('ไม่พบ GEMINI_API_KEY ในระบบ สำหรับการใช้งานเสียง Gemini');

  let prefix = emotionInstruction || '';
  if (speedFactor <= 0.85) prefix = `พูดช้าลงกว่าปกติ ${prefix}`;
  else if (speedFactor >= 1.15) prefix = `พูดเร็วขึ้นกว่าปกติเล็กน้อย ${prefix}`;
  const fullText = prefix ? `${prefix}${prefix.endsWith(': ') ? '' : ': '}${text}` : text;

  console.log(`[Gemini TTS] voice=${voiceId} emotion="${emotionInstruction.slice(0, 40)}"`);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: fullText }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } }
      }
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS ล้มเหลว (${res.status}): ${errText.slice(0, 150)}`);
  }
  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('Gemini TTS ไม่ได้ส่งเสียงกลับมา');
  const pcm = Buffer.from(b64, 'base64');

  const dir = os.tmpdir();
  const inPath = path.join(dir, `gtts_${Date.now()}.pcm`);
  const outPath = path.join(dir, `gtts_${Date.now()}.mp3`);
  try {
    fs.writeFileSync(inPath, pcm);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .inputOptions(['-f s16le', '-ar 24000', '-ac 1'])
        .outputOptions(['-c:a libmp3lame', '-b:a 128k'])
        .on('end', () => resolve())
        .on('error', (err: any) => reject(err))
        .save(outPath);
    });
    return fs.readFileSync(outPath) as Buffer;
  } finally {
    for (const p of [inPath, outPath]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}

export async function generateGoogleTTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  if (!apiKey) throw new Error('ไม่พบ GOOGLE_API_KEY ในระบบ สำหรับการใช้งาน Google TTS');

  console.log(`[Google TTS] Generating Thai TTS audio for voice ID: ${voiceId} with speed factor: ${speedFactor}`);

  const googleResponse = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { text: text },
      voice: {
        languageCode: 'th-TH',
        name: voiceId,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: speedFactor,
      },
    }),
  });

  if (!googleResponse.ok) {
    const errText = await googleResponse.text();
    console.error('[Google TTS API Error]', errText);
    throw new Error(`Google Cloud TTS API failed with status ${googleResponse.status}: ${errText}`);
  }

  const data = await googleResponse.json();

  if (!data.audioContent) {
    throw new Error('Google Cloud TTS did not return audioContent');
  }

  return Buffer.from(data.audioContent, 'base64');
}

export async function generateOpenAITTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) throw new Error('ไม่พบ OPENAI_API_KEY ในระบบ สำหรับการใช้งาน OpenAI TTS');

  console.log(`[OpenAI TTS] Generating Thai TTS audio for voice ID: ${voiceId} with speed factor: ${speedFactor}`);

  const openAIResponse = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voiceId,
      response_format: 'mp3',
      speed: speedFactor,
    }),
  });

  if (!openAIResponse.ok) {
    const errText = await openAIResponse.text();
    console.error('[OpenAI TTS API Error]', errText);
    throw new Error(`OpenAI TTS API failed with status ${openAIResponse.status}: ${errText}`);
  }

  const arrayBuffer = await openAIResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function generateCosyVoiceTTS(text: string, voiceId: string, speedFactor: number = 1.0): Promise<Buffer> {
  const apiKey = process.env.SILICONFLOW_API_KEY || process.env.NEXT_PUBLIC_SILICONFLOW_API_KEY || '';
  if (!apiKey) throw new Error('ไม่พบ SILICONFLOW_API_KEY ในระบบ สำหรับการใช้งาน CosyVoice TTS');

  console.log(`[SiliconFlow CosyVoice] Generating TTS audio for voice ID: ${voiceId} with speed: ${speedFactor}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const sfResponse = await fetch('https://api.siliconflow.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        input: text,
        voice: voiceId,
        response_format: 'mp3',
        speed: speedFactor,
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!sfResponse.ok) {
      const errText = await sfResponse.text();
      console.error('[SiliconFlow CosyVoice API Error]', errText);
      throw new Error(`SiliconFlow CosyVoice API failed with status ${sfResponse.status}: ${errText}`);
    }

    const arrayBuffer = await sfResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('การเชื่อมต่อกับ SiliconFlow CosyVoice หมดเวลา (Timeout) กรุณาลองใหม่อีกครั้ง');
    }
    throw err;
  }
}

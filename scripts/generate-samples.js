const fs = require('fs');
const path = require('path');

// 1. Simple parser for .env.local file to load credentials
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('Cannot find .env.local file at:', envPath);
    process.exit(1);
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    let val = parts.slice(1).join('=').trim();
    // Strip quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
  return env;
}

const env = loadEnv();
const openAIKey = env.OPENAI_API_KEY;
const googleKey = env.GOOGLE_API_KEY || env.NEXT_PUBLIC_GOOGLE_API_KEY;

if (!openAIKey) {
  console.error('Missing OPENAI_API_KEY in .env.local');
}
if (!googleKey) {
  console.error('Missing GOOGLE_API_KEY in .env.local');
}

const samplesDir = path.join(__dirname, '..', 'public', 'samples');
if (!fs.existsSync(samplesDir)) {
  fs.mkdirSync(samplesDir, { recursive: true });
}

// 2. Google Cloud TTS generator function
async function generateGoogleTTS(voiceId, text, filename) {
  console.log(`Generating Google TTS sample for ${voiceId}...`);
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode: 'th-TH',
        name: voiceId
      },
      audioConfig: {
        audioEncoding: 'MP3'
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google TTS failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  if (!data.audioContent) {
    throw new Error('Google TTS did not return audioContent');
  }

  const buffer = Buffer.from(data.audioContent, 'base64');
  const filePath = path.join(samplesDir, filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`Save Google TTS sample to: ${filePath}`);
}

// 3. OpenAI TTS generator function
async function generateOpenAITTS(voiceId, text, filename) {
  console.log(`Generating OpenAI TTS sample for ${voiceId}...`);
  const url = 'https://api.openai.com/v1/audio/speech';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voiceId
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI TTS failed: ${response.status} - ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filePath = path.join(samplesDir, filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`Save OpenAI TTS sample to: ${filePath}`);
}

async function main() {
  // Google Voices Config
  const googleVoices = [
    { id: 'th-TH-Neural2-C', text: 'สวัสดีค่ะ นี่คือเสียงตัวอย่างภาษาไทยของกูเกิ้ล นิวรอล ทู ซี', filename: 'g-neural-c.mp3' },
    { id: 'th-TH-Standard-A', text: 'สวัสดีค่ะ นี่คือเสียงตัวอย่างภาษาไทยของกูเกิ้ล สแตนดาร์ด เอ', filename: 'g-standard-a.mp3' },
    { id: 'th-TH-Chirp3-HD-Algenib', text: 'สวัสดีครับ นี่คือเสียงตัวอย่างภาษาไทยของกูเกิ้ล เชิร์ป อัลเจนิบ', filename: 'g-chirp-algenib.mp3' },
  ];

  // OpenAI Voices Config
  const openAIVoices = [
    { id: 'alloy', text: 'Hello! This is a preview of the OpenAI Alloy voice.', filename: 'alloy.mp3' },
    { id: 'nova', text: 'Hello! This is a preview of the OpenAI Nova voice.', filename: 'nova.mp3' },
    { id: 'shimmer', text: 'Hello! This is a preview of the OpenAI Shimmer voice.', filename: 'shimmer.mp3' },
    { id: 'echo', text: 'Hello! This is a preview of the OpenAI Echo voice.', filename: 'echo.mp3' },
    { id: 'onyx', text: 'Hello! This is a preview of the OpenAI Onyx voice.', filename: 'onyx.mp3' },
    { id: 'fable', text: 'Hello! This is a preview of the OpenAI Fable voice.', filename: 'fable.mp3' },
  ];

  // Generate Google TTS samples
  if (googleKey) {
    for (const voice of googleVoices) {
      try {
        await generateGoogleTTS(voice.id, voice.text, voice.filename);
      } catch (err) {
        console.error(`Failed to generate Google voice ${voice.id}:`, err.message);
      }
    }
  }

  // Generate OpenAI TTS samples
  if (openAIKey) {
    for (const voice of openAIVoices) {
      try {
        await generateOpenAITTS(voice.id, voice.text, voice.filename);
      } catch (err) {
        console.error(`Failed to generate OpenAI voice ${voice.id}:`, err.message);
      }
    }
  }

  console.log('All sample generation completed!');
}

main().catch(err => {
  console.error('Fatal execution error:', err);
});

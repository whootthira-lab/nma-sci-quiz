const fs = require('fs');
const path = require('path');

// Load env variables
const envPath = path.join(__dirname, '..', '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('.env.local file not found');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] ? match[2].trim() : '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    env[match[1]] = value;
  }
});

const sfKey = env.SILICONFLOW_API_KEY || env.NEXT_PUBLIC_SILICONFLOW_API_KEY;

if (!sfKey) {
  console.error('Missing SILICONFLOW_API_KEY in .env.local');
  process.exit(1);
}

const voices = [
  { id: 'anna', name: 'cosy-anna.mp3', text: 'Hello, my name is Anna. I am a polite female voice.' },
  { id: 'claire', name: 'cosy-claire.mp3', text: 'Hello, my name is Claire. I am a gentle female voice.' },
  { id: 'bella', name: 'cosy-bella.mp3', text: 'Hello, my name is Bella. I am a cheerful female voice.' },
  { id: 'diana', name: 'cosy-diana.mp3', text: 'Hello, my name is Diana. I am a confident female voice.' },
  { id: 'alex', name: 'cosy-alex.mp3', text: 'Hello, my name is Alex. I am a mature male voice.' },
  { id: 'benjamin', name: 'cosy-benjamin.mp3', text: 'Hello, my name is Benjamin. I am a warm male voice.' },
  { id: 'charles', name: 'cosy-charles.mp3', text: 'Hello, my name is Charles. I am a polite male voice.' },
  { id: 'david', name: 'cosy-david.mp3', text: 'Hello, my name is David. I am a powerful male voice.' }
];

const samplesDir = path.join(__dirname, '..', 'public', 'samples');
if (!fs.existsSync(samplesDir)) {
  fs.mkdirSync(samplesDir, { recursive: true });
}

async function generateSample(voice) {
  const outputPath = path.join(samplesDir, voice.name);
  console.log(`Generating sample for ${voice.id}...`);

  const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sfKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: voice.text,
      voice: voice.id,
      response_format: 'mp3'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to generate voice ${voice.id}: ${response.status} - ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
  console.log(`Saved: ${outputPath}`);
}

async function run() {
  for (const voice of voices) {
    try {
      await generateSample(voice);
      // Avoid rate limit
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(err.message);
    }
  }
  console.log('Done.');
}

run();

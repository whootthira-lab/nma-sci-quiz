const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    let val = parts.slice(1).join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
  return env;
}

const env = loadEnv();
const googleKey = env.GOOGLE_API_KEY || env.NEXT_PUBLIC_GOOGLE_API_KEY;

if (!googleKey) {
  console.error('Missing GOOGLE_API_KEY');
  process.exit(1);
}

async function main() {
  const url = `https://texttospeech.googleapis.com/v1/voices?key=${googleKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    console.error('API Error:', text);
    process.exit(1);
  }
  const data = await response.json();
  const thaiVoices = data.voices.filter(v => v.languageCodes.includes('th-TH'));
  console.log(JSON.stringify(thaiVoices, null, 2));
}

main().catch(console.error);

// ─── Firebase Document Types ────────────────────────

export interface UserDoc {
  email: string;
  is_admin: boolean;
  last_login: Date;
  expires_at: Date;
  display_name?: string;
  generation_limit?: number;
}

export interface GenerationDoc {
  id?: string;
  user_email: string;
  mode: 'text-to-video' | 'face-motion';
  script_text: string;
  situation_prompt: string;
  model_name: string;
  voice_id: string;
  image_url: string;
  video_url: string;
  storage_path: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message?: string;
  created_at: Date;
  expires_at: Date;
  aspect_ratio?: string;
  duration_estimate?: number;
}

// ─── Thai Voice Options (Botnoi & Google Neural2 Edition) ────

export interface ThaiVoice {
  id: string;
  name: string;
  label: string;
  gender: 'male' | 'female';
  sample_url: string;
  provider: 'botnoi' | 'google' | 'openai' | 'cosyvoice' | 'gemini';
  // 'native' = ออกเสียงไทยได้ถูกต้องตามธรรมชาติ, 'foreign' = โมเดลไม่ได้เทรนภาษาไทยโดยตรง จะมีสำเนียงต่างชาติเมื่ออ่านไทย
  accent?: 'native' | 'foreign';
}

export const THAI_VOICES: ThaiVoice[] = [
  // Gemini TTS — เสียงกลุ่มทดลอง สั่งอารมณ์ด้วยข้อความได้ (คัดชุดสุดท้ายหลังทีมฟังจากห้องฟังเสียง)
  { id: 'Kore', name: 'Kore', label: '🧪 คอรี (หญิง, Gemini สั่งอารมณ์ได้)', gender: 'female', sample_url: '', provider: 'gemini' },
  { id: 'Aoede', name: 'Aoede', label: '🧪 อาอีดี (หญิง, Gemini สั่งอารมณ์ได้)', gender: 'female', sample_url: '', provider: 'gemini' },
  { id: 'Leda', name: 'Leda', label: '🧪 ลีดา (หญิง, Gemini สั่งอารมณ์ได้)', gender: 'female', sample_url: '', provider: 'gemini' },
  { id: 'Zephyr', name: 'Zephyr', label: '🧪 เซเฟอร์ (หญิง, Gemini สั่งอารมณ์ได้)', gender: 'female', sample_url: '', provider: 'gemini' },
  { id: 'Charon', name: 'Charon', label: '🧪 คารอน (ชาย, Gemini สั่งอารมณ์ได้)', gender: 'male', sample_url: '', provider: 'gemini' },
  { id: 'Puck', name: 'Puck', label: '🧪 พัค (ชาย, Gemini สั่งอารมณ์ได้)', gender: 'male', sample_url: '', provider: 'gemini' },
  { id: 'Orus', name: 'Orus', label: '🧪 โอรัส (ชาย, Gemini สั่งอารมณ์ได้)', gender: 'male', sample_url: '', provider: 'gemini' },
  { id: 'Fenrir', name: 'Fenrir', label: '🧪 เฟนเรียร์ (ชาย, Gemini สั่งอารมณ์ได้)', gender: 'male', sample_url: '', provider: 'gemini' },

  // Google Cloud TTS (Neural2, Standard, Chirp3) — เสียงไทยแท้ (native th-TH)
  { id: 'th-TH-Neural2-C', name: 'G-Neural-C', label: '🇹🇭 จี-เนอรัล C (หญิง, ไทยแท้ Neural2 สมจริง)', gender: 'female', sample_url: '/samples/g-neural-c.mp3', provider: 'google', accent: 'native' },
  { id: 'th-TH-Standard-A', name: 'G-Standard-A', label: '🇹🇭 จี-สแตนดาร์ด A (หญิง, ไทยแท้ คุ้มค่า)', gender: 'female', sample_url: '/samples/g-standard-a.mp3', provider: 'google', accent: 'native' },
  { id: 'th-TH-Chirp3-HD-Algenib', name: 'G-Chirp-Algenib', label: '🇹🇭 จี-เชิร์ป Algenib (ชาย, ไทยแท้ HD)', gender: 'male', sample_url: '/samples/g-chirp-algenib.mp3', provider: 'google', accent: 'native' },

  // OpenAI TTS — โมเดล multilingual ไม่ได้เทรนไทยโดยตรง จะมีสำเนียงต่างชาติ
  { id: 'alloy', name: 'Alloy', label: 'อัลลอย (กลาง) — ⚠️ สำเนียงต่างชาติ', gender: 'female', sample_url: '/samples/alloy.mp3', provider: 'openai', accent: 'foreign' },
  { id: 'nova', name: 'Nova', label: 'โนวา (หญิง) — ⚠️ สำเนียงต่างชาติ', gender: 'female', sample_url: '/samples/nova.mp3', provider: 'openai', accent: 'foreign' },
  { id: 'shimmer', name: 'Shimmer', label: 'ชิมเมอร์ (หญิง) — ⚠️ สำเนียงต่างชาติ', gender: 'female', sample_url: '/samples/shimmer.mp3', provider: 'openai', accent: 'foreign' },
  { id: 'echo', name: 'Echo', label: 'เอคโค่ (ชาย) — ⚠️ สำเนียงต่างชาติ', gender: 'male', sample_url: '/samples/echo.mp3', provider: 'openai', accent: 'foreign' },
  { id: 'onyx', name: 'Onyx', label: 'โอนิกส์ (ชาย) — ⚠️ สำเนียงต่างชาติ', gender: 'male', sample_url: '/samples/onyx.mp3', provider: 'openai', accent: 'foreign' },
  { id: 'fable', name: 'Fable', label: 'เฟเบิล (ชาย) — ⚠️ สำเนียงต่างชาติ', gender: 'male', sample_url: '/samples/fable.mp3', provider: 'openai', accent: 'foreign' },

  // Alibaba CosyVoice via SiliconFlow — โมเดลรองรับ จีน/อังกฤษ/ญี่ปุ่น/เกาหลี ไม่รองรับไทย จะเป็นสำเนียง "ฝรั่งพูดไทย"
  { id: 'FunAudioLLM/CosyVoice2-0.5B:anna', name: 'Cosy-Anna', label: 'คอซี่-แอนนา (หญิง) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'female', sample_url: '/samples/cosy-anna.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:claire', name: 'Cosy-Claire', label: 'คอซี่-แคลร์ (หญิง) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'female', sample_url: '/samples/cosy-claire.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:bella', name: 'Cosy-Bella', label: 'คอซี่-เบลล่า (หญิง) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'female', sample_url: '/samples/cosy-bella.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:diana', name: 'Cosy-Diana', label: 'คอซี่-ไดอาน่า (หญิง) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'female', sample_url: '/samples/cosy-diana.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:alex', name: 'Cosy-Alex', label: 'คอซี่-อเล็กซ์ (ชาย) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'male', sample_url: '/samples/cosy-alex.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', name: 'Cosy-Benjamin', label: 'คอซี่-เบนจามิน (ชาย) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'male', sample_url: '/samples/cosy-benjamin.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:charles', name: 'Cosy-Charles', label: 'คอซี่-ชาร์ลส์ (ชาย) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'male', sample_url: '/samples/cosy-charles.mp3', provider: 'cosyvoice', accent: 'foreign' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:david', name: 'Cosy-David', label: 'คอซี่-เดวิด (ชาย) — ⚠️ สำเนียงต่างชาติ (ไม่รองรับไทยเต็มรูปแบบ)', gender: 'male', sample_url: '/samples/cosy-david.mp3', provider: 'cosyvoice', accent: 'foreign' },
];

// ─── Character Emotions ─────────────────────────────
// One vocabulary shared by LoRA training and generation. They used to differ — training
// captioned an expression "joyful expression" while generation asked for "Friendly &
// Smiling", so the trained expressions were never actually triggered.

export interface CharacterEmotion {
  id: string;
  label: string;   // shown to the user
  tags: string;    // written into training captions and generation prompts
}

export const CHARACTER_EMOTIONS: CharacterEmotion[] = [
  { id: 'happy', label: '😊 ยิ้มแย้ม เป็นกันเอง', tags: 'smiling cheerfully, friendly warm expression, joyful' },
  { id: 'serious', label: '💼 สุขุม จริงจัง มืออาชีพ', tags: 'serious professional expression, calm and composed, confident' },
  { id: 'excited', label: '⚡ กระตือรือร้น ตื่นเต้น', tags: 'energetic excited expression, bright eyes, enthusiastic' },
  { id: 'gentle', label: '🤝 อ่อนโยน เห็นอกเห็นใจ', tags: 'gentle empathetic expression, soft caring look' },
  { id: 'worried', label: '😨 กังวล กลัว', tags: 'worried fearful expression, furrowed brows, anxious look' },
  { id: 'sad', label: '😢 เศร้า หมองหม่น', tags: 'sad face, gloomy downcast expression, sorrowful' },
  { id: 'angry', label: '😠 โกรธ ไม่พอใจ', tags: 'angry expression, frowning face, annoyed look' },
  { id: 'shocked', label: '😲 ตกใจ ประหลาดใจ', tags: 'shocked face, mouth open in disbelief, wide surprised eyes' },
];

export const emotionTagsById = (id: string, customTag?: string): string => {
  if (id === 'custom') return customTag || 'expressive face';
  return CHARACTER_EMOTIONS.find((e) => e.id === id)?.tags || 'expressive face';
};

// ─── Aspect Ratio Options ───────────────────────────

export interface AspectOption {
  value: string;
  label: string;
  icon: string;
  width: number;
  height: number;
}

export const ASPECT_RATIOS: AspectOption[] = [
  { value: '1:1', label: '1:1 สี่เหลี่ยม', icon: '⬜', width: 512, height: 512 },
  { value: '16:9', label: '16:9 แนวนอน', icon: '🖥️', width: 832, height: 480 },
  { value: '9:16', label: '9:16 แนวตั้ง', icon: '📱', width: 480, height: 832 },
];

// ─── Face Motion Models ─────────────────────────────

export interface FaceMotionModel {
  id: string;
  name: string;
  description: string;
  fal_endpoint: string;
}

export const FACE_MOTION_MODELS: FaceMotionModel[] = [
  {
    id: 'liveportrait',
    name: 'LivePortrait',
    description: 'ควบคุมการเคลื่อนไหวใบหน้าแม่นยำสูง รองรับทั้งภาพถ่ายและการ์ตูน',
    fal_endpoint: 'fal-ai/liveportrait',
  },
  {
    id: 'hallo',
    name: 'Hallo',
    description: 'สร้างวิดีโอจากภาพนิ่งด้วย Audio-driven, เหมาะกับงานพากย์เสียง',
    fal_endpoint: 'fal-ai/hallo',
  },
];

// ─── Admin Config ───────────────────────────────────

export interface AdminConfig {
  mode1_enabled: boolean;
  mode2_enabled: boolean;
  max_daily_generations: number;
}

// ─── API Request/Response ───────────────────────────

export interface GenerateVideoRequest {
  mode: 'text-to-video' | 'face-motion';
  script_text?: string;
  situation_prompt?: string;
  voice_id?: string;
  image_url: string;
  aspect_ratio?: string;
  driving_video_url?: string;
  model_id?: string;
}

export interface GenerateVideoResponse {
  success: boolean;
  video_url?: string;
  storage_path?: string;
  error?: string;
  generation_id?: string;
}

// ─── Duration Estimation ────────────────────────────

export function estimateThaiDuration(text: string): number {
  const cleanText = text.replace(/\s+/g, '').trim();
  const charCount = cleanText.length;
  // Thai speech rate: ~17 characters per second
  const seconds = Math.ceil(charCount / 17);
  return Math.max(3, Math.min(seconds, 30)); // Clamp 3-30s
}

// น้ำเสียงที่สั่งได้เมื่อใช้เสียง Gemini — ชุดเดียวกับอารมณ์ตัวละคร/ฉาก เพื่อให้หน้ากับเสียง
// เลือกครั้งเดียวแล้วไปด้วยกัน (ค่าเริ่มต้น 'auto' ดึงจากอารมณ์ตัวละครที่เลือกไว้) บวกโทน
// เฉพาะงานเสียงอีกสองแบบ ข้อความ instruction คือคำสั่งจริงที่ส่งนำหน้าบทให้โมเดล
export const VOICE_EMOTIONS: { id: string; label: string; instruction: string }[] = [
  { id: 'auto',      label: '🎭 ตามอารมณ์ตัวละคร/ฉากที่เลือกไว้ (อัตโนมัติ)', instruction: '' },
  { id: 'none',      label: '🎙 โทนปกติ',                 instruction: '' },
  { id: 'happy',     label: '😊 ยิ้มแย้ม เป็นกันเอง',        instruction: 'พูดด้วยน้ำเสียงสดใส ยิ้มแย้ม เป็นกันเอง อบอุ่นเหมือนครูใจดี: ' },
  { id: 'serious',   label: '💼 สุขุม จริงจัง มืออาชีพ',      instruction: 'พูดด้วยน้ำเสียงสุขุม จริงจัง ชัดถ้อยชัดคำ น่าเชื่อถือแบบมืออาชีพ: ' },
  { id: 'excited',   label: '⚡ กระตือรือร้น ตื่นเต้น',        instruction: 'พูดด้วยน้ำเสียงตื่นเต้น กระตือรือร้น มีพลัง ชวนให้อยากรู้: ' },
  { id: 'gentle',    label: '🤝 อ่อนโยน เห็นอกเห็นใจ',       instruction: 'พูดด้วยน้ำเสียงอ่อนโยน นุ่มนวล เห็นอกเห็นใจ ปลอบประโลม: ' },
  { id: 'worried',   label: '😨 กังวล กลัว',                instruction: 'พูดด้วยน้ำเสียงกังวล หวั่นไหว มีความกลัวแฝงอยู่ เสียงสั่นเล็กน้อย: ' },
  { id: 'sad',       label: '😢 เศร้า หมองหม่น',             instruction: 'พูดด้วยน้ำเสียงเศร้า แผ่วเบา หมองหม่น สะเทือนใจ: ' },
  { id: 'angry',     label: '😠 โกรธ ไม่พอใจ',              instruction: 'พูดด้วยน้ำเสียงโกรธ ไม่พอใจ เสียงแข็งกดดัน แต่ยังชัดถ้อยชัดคำ: ' },
  { id: 'shocked',   label: '😲 ตกใจ ประหลาดใจ',            instruction: 'พูดด้วยน้ำเสียงตกใจ ประหลาดใจ อุทานเป็นธรรมชาติ จังหวะเร็วขึ้น: ' },
  { id: 'storytale', label: '📖 เล่านิทาน',                 instruction: 'พูดแบบนักเล่านิทาน มีจังหวะขึ้นลง ชวนติดตาม ใส่ความรู้สึกตามเนื้อเรื่อง: ' },
  { id: 'playful',   label: '😜 ขี้เล่น แซวๆ',               instruction: 'พูดด้วยน้ำเสียงขี้เล่น แซวๆ มีอารมณ์ขัน เหมือนคุยกับเพื่อนสนิท: ' },
];

// แปลง id อารมณ์ (ชุดเดียวกับ CHARACTER_EMOTIONS) เป็นคำสั่งน้ำเสียง — ใช้ตอนโหมดอัตโนมัติ
export const voiceInstructionByEmotionId = (id: string, customText?: string): string => {
  if (id === 'custom' && customText) return `พูดด้วยน้ำเสียงตามอารมณ์นี้: ${customText}. `;
  return VOICE_EMOTIONS.find((e) => e.id === id)?.instruction || '';
};

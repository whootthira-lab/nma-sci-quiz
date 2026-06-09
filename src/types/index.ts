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
  provider: 'botnoi' | 'google' | 'openai' | 'cosyvoice';
}

export const THAI_VOICES: ThaiVoice[] = [
  // Google Cloud TTS (Neural2, Standard, Chirp3)
  { id: 'th-TH-Neural2-C', name: 'G-Neural-C', label: 'จี-เนอรัล C (หญิง, Neural2 สมจริง)', gender: 'female', sample_url: '/samples/g-neural-c.mp3', provider: 'google' },
  { id: 'th-TH-Standard-A', name: 'G-Standard-A', label: 'จี-สแตนดาร์ด A (หญิง, คุ้มค่า)', gender: 'female', sample_url: '/samples/g-standard-a.mp3', provider: 'google' },
  { id: 'th-TH-Chirp3-HD-Algenib', name: 'G-Chirp-Algenib', label: 'จี-เชิร์ป Algenib (ชาย, HD)', gender: 'male', sample_url: '/samples/g-chirp-algenib.mp3', provider: 'google' },

  // OpenAI TTS
  { id: 'alloy', name: 'Alloy', label: 'อัลลอย (กลาง, สากล)', gender: 'female', sample_url: '/samples/alloy.mp3', provider: 'openai' },
  { id: 'nova', name: 'Nova', label: 'โนวา (หญิง, สดใส)', gender: 'female', sample_url: '/samples/nova.mp3', provider: 'openai' },
  { id: 'shimmer', name: 'Shimmer', label: 'ชิมเมอร์ (หญิง, นุ่มนวล)', gender: 'female', sample_url: '/samples/shimmer.mp3', provider: 'openai' },
  { id: 'echo', name: 'Echo', label: 'เอคโค่ (ชาย, อบอุ่น)', gender: 'male', sample_url: '/samples/echo.mp3', provider: 'openai' },
  { id: 'onyx', name: 'Onyx', label: 'โอนิกส์ (ชาย, เข้ม)', gender: 'male', sample_url: '/samples/onyx.mp3', provider: 'openai' },
  { id: 'fable', name: 'Fable', label: 'เฟเบิล (ชาย, บรรยาย)', gender: 'male', sample_url: '/samples/fable.mp3', provider: 'openai' },

  // Alibaba CosyVoice via SiliconFlow
  { id: 'FunAudioLLM/CosyVoice2-0.5B:anna', name: 'Cosy-Anna', label: 'คอซี่-แอนนา (หญิง, สุภาพ)', gender: 'female', sample_url: '/samples/cosy-anna.mp3', provider: 'cosyvoice' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:claire', name: 'Cosy-Claire', label: 'คอซี่-แคลร์ (หญิง, อ่อนโยน)', gender: 'female', sample_url: '/samples/cosy-claire.mp3', provider: 'cosyvoice' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:alex', name: 'Cosy-Alex', label: 'คอซี่-อเล็กซ์ (ชาย, สุขุม)', gender: 'male', sample_url: '/samples/cosy-alex.mp3', provider: 'cosyvoice' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', name: 'Cosy-Benjamin', label: 'คอซี่-เบนจามิน (ชาย, ทุ้ม)', gender: 'male', sample_url: '/samples/cosy-benjamin.mp3', provider: 'cosyvoice' },
];

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
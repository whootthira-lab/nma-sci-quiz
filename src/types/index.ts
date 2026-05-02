// ─── Firebase Document Types ────────────────────────

export interface UserDoc {
  email: string;
  is_admin: boolean;
  last_login: Date;
  expires_at: Date;
  display_name?: string;
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

// ─── Thai Voice Options (Botnoi Voice Edition) ──────

export interface ThaiVoice {
  id: string;
  name: string;
  label: string;
  gender: 'male' | 'female';
  sample_url: string;
}

export const THAI_VOICES: ThaiVoice[] = [
  { id: '1', name: 'Ava', label: 'เอวา (หญิง, สุภาพ)', gender: 'female', sample_url: '/samples/ava.mp3' },
  { id: '2', name: 'Kacha', label: 'คชา (ชาย, สุภาพ)', gender: 'male', sample_url: '/samples/kacha.mp3' },
  { id: '3', name: 'Jaidee', label: 'ใจดี (หญิง, อบอุ่น)', gender: 'female', sample_url: '/samples/jaidee.mp3' },
  { id: '4', name: 'Te', label: 'เท่ห์ (ชาย, วัยรุ่น)', gender: 'male', sample_url: '/samples/te.mp3' },
  { id: '15', name: 'Yim', label: 'ยิ้ม (หญิง, ร่าเริง)', gender: 'female', sample_url: '/samples/yim.mp3' },
  { id: '33', name: 'Lung', label: 'ลุง (ชาย, ใจดี)', gender: 'male', sample_url: '/samples/lung.mp3' },
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
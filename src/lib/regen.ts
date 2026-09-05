import { supabase } from './supabase-db';

/**
 * "สร้างอีกครั้ง" hands a finished gallery item back to the form that made it. The gallery
 * stashes everything it knows here, navigates to the studio, and the matching form picks
 * the payload up on mount and fills itself in — the user edits or submits as-is.
 * sessionStorage so an abandoned regen dies with the tab instead of surprising a later visit.
 */

const KEY = 'kruth_regen_payload';

export interface RegenPayload {
  mode: string; // metadata.mode: image-*, image_to_video, text_to_video, motion-control, face-motion, dialogue*
  prompt: string;
  script_text: string;
  situation_prompt: string;
  model_name: string;
  voice_id: string;
  aspect_ratio: string;
  source_image_url: string | null;
  metadata: Record<string, any>;
}

export function stashRegen(payload: RegenPayload) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* private windows may refuse; the button then simply lands on the studio */
  }
}

/** Which studio tab recreates a given mode. */
export function regenTab(mode: string): 'image' | 'mode1' | 'mode2' | 'dialogue' | 'vfx' {
  if (mode.startsWith('image-')) return 'image';
  if (mode === 'face-motion') return 'mode2';
  if (mode.startsWith('dialogue')) return 'dialogue';
  if (mode.startsWith('vfx')) return 'vfx';
  return 'mode1'; // image_to_video, text_to_video, motion-control and the rest
}

/** Read without consuming — the dashboard uses this to pick the tab. */
export function peekRegen(): RegenPayload | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RegenPayload) : null;
  } catch {
    return null;
  }
}

/** A form claims the payload meant for it; anything else stays put. */
export function takeRegen(tab: 'image' | 'mode1' | 'mode2' | 'dialogue' | 'vfx'): RegenPayload | null {
  const payload = peekRegen();
  if (!payload || regenTab(payload.mode || '') !== tab) return null;
  try {
    sessionStorage.removeItem(KEY);
  } catch { /* already read — fine */ }
  return payload;
}

/** Public URL for a path in the app's storage bucket. */
export function storageUrl(path: string): string {
  return supabase.storage.from('kruth-ai-assets').getPublicUrl(path).data.publicUrl;
}

/**
 * Re-attach a stored file as if the user had just picked it. Best-effort: a deleted or
 * unreachable file returns null and the form simply starts without that attachment.
 */
export async function urlToFile(url: string, name: string, fallbackType = 'image/png'): Promise<File | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || fallbackType });
  } catch {
    return null;
  }
}

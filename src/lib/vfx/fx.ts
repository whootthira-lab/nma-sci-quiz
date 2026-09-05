import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient, publicUrl } from './store';

/**
 * Stock FX library (Phase 2). Each element is a short clip of the effect on PURE BLACK —
 * smoke, embers, rain, light leaks. Composited with a `screen` blend, black contributes
 * nothing and the effect adds light, which is how emissive/atmospheric FX were layered
 * long before alpha channels: the deployed ffmpeg cannot decode VP9 alpha, and this needs
 * no alpha at all. Clips loop to the shot's length.
 *
 * Manifest: kruth-ai-assets/vfx_fx/library.json. Clips: kruth-ai-assets/vfx_fx/<id>.mp4.
 */

export interface FxElement {
  id: string;
  label: string;         // Thai label shown in the picker
  url: string;
  seconds: number;
  /** how it is meant to sit: emissive things go in front, atmosphere may go behind the person */
  default_placement: 'front' | 'behind';
  default_opacity: number; // 0–1
  tags: string[];
  source: 'generated' | 'uploaded';
  created_at: string;
}

export interface FxParams {
  fx_id: string;
  opacity: number;          // 0–1
  placement: 'front' | 'behind';
  /** screen is the default for on-black FX; lighten keeps highlights only; add is stronger */
  blend: 'screen' | 'lighten' | 'addition';
  /** optional: shift/scale the element (1 = cover the frame) */
  scale?: number;
}

const BUCKET = 'kruth-ai-assets';
const MANIFEST = 'vfx_fx/library.json';

export async function loadFxLibrary(supabase: SupabaseClient = serviceClient()): Promise<FxElement[]> {
  const { data, error } = await supabase.storage.from(BUCKET).download(MANIFEST);
  if (error || !data) return [];
  try {
    const j = JSON.parse(await data.text());
    return Array.isArray(j?.elements) ? j.elements : [];
  } catch {
    return [];
  }
}

export async function saveFxLibrary(elements: FxElement[], supabase: SupabaseClient = serviceClient()): Promise<void> {
  const body = Buffer.from(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), elements }), 'utf8');
  const { error } = await supabase.storage.from(BUCKET).upload(MANIFEST, body, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกคลัง FX ไม่สำเร็จ: ${error.message}`);
}

export function fxClipPath(id: string) {
  return `vfx_fx/${id}.mp4`;
}

export function fxClipUrl(id: string, supabase: SupabaseClient = serviceClient()) {
  return publicUrl(fxClipPath(id), supabase);
}

export function defaultFxParams(el: FxElement): FxParams {
  return { fx_id: el.id, opacity: el.default_opacity, placement: el.default_placement, blend: 'screen', scale: 1 };
}

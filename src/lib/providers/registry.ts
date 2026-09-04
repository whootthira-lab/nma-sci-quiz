/**
 * The model catalog — every number the app charges or spends, in one place, with where
 * it came from. Prices are what Fal BILLED (usage CSV) where we have it, list price
 * otherwise; credits are stored ×10 of the displayed value, 1 displayed credit ≈ $0.01.
 *
 * `verified` means a real submit → fetched result was seen on this endpoint. The queue
 * accepts any path, so an unverified entry may not exist at all — the UI must not offer
 * it, and the router must refuse it, until someone proves it and flips the flag.
 *
 * `tier` is the product line the model belongs to now that the studio is moving from
 * classroom clips toward production work: economy = the calibrated defaults, pro = better
 * fidelity at a real premium, ultra = flagship/4K/cinematic.
 */

export type Tier = 'economy' | 'pro' | 'ultra';
export type Unit = 'second' | 'image' | 'megapixel' | 'clip';

export interface ModelEntry {
  id: string;            // registry key, stable across endpoint changes
  task: string;          // what it does, for the router
  endpoint: string;      // exact Fal path — pinned; never auto-upgraded
  label: string;         // Thai UI label
  tier: Tier;
  unit: Unit;
  usdPerUnit: number;    // billed rate where known
  creditsPerUnit: number;// displayed credits per unit
  verified: boolean;     // submit → result seen with our own eyes
  priceSource: 'bill' | 'list' | 'measured';
  note?: string;
}

export const MODELS: ModelEntry[] = [
  // ── video: base generation ──────────────────────────────────────────────
  { id: 'kling-720', task: 'video.i2v', endpoint: 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video', label: 'Kling 720p (มาตรฐาน)', tier: 'economy', unit: 'second', usdPerUnit: 0.042, creditsPerUnit: 5, verified: true, priceSource: 'bill' },
  { id: 'kling-1080', task: 'video.i2v', endpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video', label: 'Kling 1080p Pro', tier: 'pro', unit: 'second', usdPerUnit: 0.07, creditsPerUnit: 8, verified: true, priceSource: 'list', note: 'มีเสียงในตัว $0.14/s → 15 cr' },
  { id: 'kling-o3-std', task: 'video.i2v', endpoint: 'fal-ai/kling-video/o3/standard/image-to-video', label: 'Kling O3 Standard', tier: 'pro', unit: 'second', usdPerUnit: 0.084, creditsPerUnit: 10, verified: false, priceSource: 'list' },
  { id: 'kling-o3-pro', task: 'video.i2v', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video', label: 'Kling O3 Pro', tier: 'ultra', unit: 'second', usdPerUnit: 0.112, creditsPerUnit: 13, verified: false, priceSource: 'list' },
  { id: 'kling-o3-4k', task: 'video.i2v', endpoint: 'fal-ai/kling-video/o3/4k/image-to-video', label: 'Kling O3 4K', tier: 'ultra', unit: 'second', usdPerUnit: 0.42, creditsPerUnit: 48, verified: false, priceSource: 'list' },
  { id: 'seedance-720', task: 'video.i2v', endpoint: 'fal-ai/bytedance/seedance/v1/pro/image-to-video', label: 'Seedance 720p', tier: 'economy', unit: 'second', usdPerUnit: 0.052, creditsPerUnit: 6, verified: true, priceSource: 'bill' },
  { id: 'veo3', task: 'video.i2v', endpoint: 'fal-ai/veo3/image-to-video', label: 'Veo 3', tier: 'ultra', unit: 'second', usdPerUnit: 0.40, creditsPerUnit: 40, verified: true, priceSource: 'bill' },
  { id: 'sora2', task: 'video.i2v', endpoint: 'fal-ai/sora-2/image-to-video', label: 'Sora 2', tier: 'pro', unit: 'second', usdPerUnit: 0.10, creditsPerUnit: 12, verified: true, priceSource: 'bill' },
  { id: 'grok-video', task: 'video.i2v', endpoint: 'xai/grok-imagine-video/v1.5/image-to-video', label: 'Grok Video', tier: 'economy', unit: 'second', usdPerUnit: 0.01, creditsPerUnit: 4, verified: true, priceSource: 'bill', note: 'บิลจริงต่ำกว่าราคาป้ายมาก' },
  { id: 'elements', task: 'video.elements', endpoint: 'fal-ai/kling-video/v1.6/pro/elements', label: 'Kling Elements', tier: 'pro', unit: 'second', usdPerUnit: 0.098, creditsPerUnit: 10, verified: true, priceSource: 'bill' },
  { id: 'motion-control', task: 'video.motion', endpoint: 'fal-ai/kling-video/v2.6/standard/motion-control', label: 'Motion Control', tier: 'pro', unit: 'second', usdPerUnit: 0.07, creditsPerUnit: 8, verified: true, priceSource: 'list' },

  // ── video: talking / speech ─────────────────────────────────────────────
  { id: 'lipsync-kling', task: 'lipsync', endpoint: 'fal-ai/kling-video/lipsync/audio-to-video', label: 'Kling Lip-sync', tier: 'economy', unit: 'second', usdPerUnit: 0.014, creditsPerUnit: 2, verified: true, priceSource: 'bill', note: 'ปากช้า 0.25s — ชดเชยใน video-status' },
  { id: 'lipsync-v3', task: 'lipsync', endpoint: 'fal-ai/sync-lipsync/v3', label: 'Sync Lip-sync v3 (แม่นกว่า)', tier: 'ultra', unit: 'second', usdPerUnit: 0.1333, creditsPerUnit: 15, verified: true, priceSource: 'bill', note: 'ตรงภายใน ~0.1s แต่แพง 9.5×' },
  { id: 'avatar-kling', task: 'avatar', endpoint: 'fal-ai/kling-video/v1/standard/ai-avatar', label: 'Kling AI Avatar', tier: 'pro', unit: 'second', usdPerUnit: 0.113, creditsPerUnit: 13, verified: true, priceSource: 'measured' },
  { id: 'avatar-omnihuman', task: 'avatar', endpoint: 'fal-ai/bytedance/omnihuman/v1.5', label: 'OmniHuman 1.5', tier: 'ultra', unit: 'second', usdPerUnit: 0.16, creditsPerUnit: 18, verified: true, priceSource: 'measured', note: 'ปากขมุบขมิบช่วงเงียบ' },

  // ── audio ───────────────────────────────────────────────────────────────
  { id: 'ambient-mmaudio', task: 'ambient', endpoint: 'fal-ai/mmaudio-v2', label: 'เสียงบรรยากาศ (mmaudio)', tier: 'economy', unit: 'second', usdPerUnit: 0.001, creditsPerUnit: 0.2, verified: true, priceSource: 'bill' },

  // ── image ───────────────────────────────────────────────────────────────
  { id: 'flux-schnell', task: 'image.t2i', endpoint: 'fal-ai/flux/schnell', label: 'Flux Schnell', tier: 'economy', unit: 'megapixel', usdPerUnit: 0.003, creditsPerUnit: 1, verified: true, priceSource: 'bill' },
  { id: 'flux-dev', task: 'image.t2i', endpoint: 'fal-ai/flux/dev', label: 'Flux Dev', tier: 'economy', unit: 'megapixel', usdPerUnit: 0.025, creditsPerUnit: 2, verified: true, priceSource: 'bill' },
  { id: 'flux2-pro', task: 'image.t2i', endpoint: 'fal-ai/flux-2-pro', label: 'Flux 2 Pro', tier: 'pro', unit: 'megapixel', usdPerUnit: 0.03, creditsPerUnit: 4, verified: true, priceSource: 'bill' },
  { id: 'grok-image', task: 'image.t2i', endpoint: 'xai/grok-imagine-image', label: 'Grok Image', tier: 'economy', unit: 'image', usdPerUnit: 0.02, creditsPerUnit: 3, verified: true, priceSource: 'bill' },
  { id: 'edit-flux2', task: 'image.edit', endpoint: 'fal-ai/flux-2-pro/edit', label: 'Flux 2 Pro Edit', tier: 'economy', unit: 'image', usdPerUnit: 0.03, creditsPerUnit: 3, verified: true, priceSource: 'bill' },
  { id: 'edit-nano', task: 'image.edit', endpoint: 'fal-ai/nano-banana/edit', label: 'Nano Banana', tier: 'economy', unit: 'image', usdPerUnit: 0.0398, creditsPerUnit: 4, verified: true, priceSource: 'bill' },
  { id: 'edit-nano-pro', task: 'image.edit', endpoint: 'fal-ai/nano-banana-pro/edit', label: 'Nano Banana Pro', tier: 'pro', unit: 'image', usdPerUnit: 0.15, creditsPerUnit: 15, verified: true, priceSource: 'bill' },
  { id: 'edit-gpt', task: 'image.edit', endpoint: 'fal-ai/gpt-image-1/edit-image', label: 'GPT Image', tier: 'pro', unit: 'image', usdPerUnit: 0.14, creditsPerUnit: 14, verified: true, priceSource: 'bill' },
  { id: 'edit-grok', task: 'image.edit', endpoint: 'xai/grok-imagine-image/edit', label: 'Grok Edit', tier: 'economy', unit: 'image', usdPerUnit: 0.022, creditsPerUnit: 3, verified: true, priceSource: 'bill' },
  { id: 'edit-grok-q', task: 'image.edit', endpoint: 'xai/grok-imagine-image/quality/edit', label: 'Grok Edit Quality', tier: 'pro', unit: 'image', usdPerUnit: 0.06, creditsPerUnit: 7, verified: true, priceSource: 'bill' },
  { id: 'kontext', task: 'image.edit', endpoint: 'fal-ai/flux-pro/kontext', label: 'Kontext', tier: 'economy', unit: 'image', usdPerUnit: 0.04, creditsPerUnit: 4, verified: true, priceSource: 'bill' },
  { id: 'kontext-max', task: 'image.edit', endpoint: 'fal-ai/flux-pro/kontext/max', label: 'Kontext Max', tier: 'pro', unit: 'image', usdPerUnit: 0.08, creditsPerUnit: 9, verified: true, priceSource: 'bill' },
  { id: 'fill', task: 'image.fill', endpoint: 'fal-ai/flux-pro/v1/fill', label: 'Flux Fill', tier: 'economy', unit: 'clip', usdPerUnit: 0.117, creditsPerUnit: 12, verified: true, priceSource: 'bill', note: 'บิลตาม MP เข้า+ออก ~$0.117/ครั้งจริง' },
  { id: 'upscale', task: 'image.upscale', endpoint: 'fal-ai/clarity-upscaler', label: 'Clarity Upscale', tier: 'economy', unit: 'clip', usdPerUnit: 0.09, creditsPerUnit: 10, verified: true, priceSource: 'bill' },

  // ── VFX building blocks (spec) — listed today, NOT yet proven end to end ─
  { id: 'matte-veed-fast', task: 'vfx.matte', endpoint: 'veed/video-background-removal/fast', label: 'ตัดคน (veed fast)', tier: 'economy', unit: 'second', usdPerUnit: 0.012, creditsPerUnit: 2, verified: false, priceSource: 'list' },
  { id: 'matte-bria', task: 'vfx.matte', endpoint: 'bria/video/background-removal/v3', label: 'ตัดคน (Bria v3)', tier: 'pro', unit: 'second', usdPerUnit: 0.05, creditsPerUnit: 6, verified: false, priceSource: 'list' },
  { id: 'vedit-o3', task: 'vfx.background', endpoint: 'fal-ai/kling-video/o3/pro/video-to-video/edit', label: 'Kling O3 Video Edit', tier: 'ultra', unit: 'second', usdPerUnit: 0.168, creditsPerUnit: 19, verified: false, priceSource: 'list' },
  { id: 'vedit-wan27', task: 'vfx.background', endpoint: 'fal-ai/wan/v2.7/edit-video', label: 'Wan 2.7 Video Edit', tier: 'pro', unit: 'second', usdPerUnit: 0.15, creditsPerUnit: 17, verified: false, priceSource: 'list' },
  { id: 'relight-lightx', task: 'vfx.relight', endpoint: 'fal-ai/lightx/relight', label: 'LightX Relight', tier: 'pro', unit: 'second', usdPerUnit: 0.10, creditsPerUnit: 12, verified: false, priceSource: 'list' },
  { id: 'char-happyhorse', task: 'vfx.character', endpoint: 'alibaba/happy-horse/video-edit', label: 'Happy Horse Character Edit', tier: 'ultra', unit: 'second', usdPerUnit: 0.20, creditsPerUnit: 23, verified: false, priceSource: 'list', note: 'ต้องมี consent record ก่อนใช้' },
];

const byId = new Map(MODELS.map((m) => [m.id, m]));
const byEndpoint = new Map(MODELS.map((m) => [m.endpoint, m]));

export function getModel(id: string): ModelEntry | undefined {
  return byId.get(id);
}
export function modelForEndpoint(endpoint: string): ModelEntry | undefined {
  return byEndpoint.get(endpoint);
}

/** Every model that may be offered to a user for a task — verified ones only. */
export function offered(task: string, maxTier?: Tier): ModelEntry[] {
  const rank: Record<Tier, number> = { economy: 0, pro: 1, ultra: 2 };
  return MODELS.filter(
    (m) => m.task === task && m.verified && (!maxTier || rank[m.tier] <= rank[maxTier])
  );
}

/**
 * What a job will cost before it runs — the number the user confirms and the number
 * the ledger deducts must be this same one. Credits come back in the stored ×10 form.
 */
export function estimateCost(id: string, units: number): { usd: number; creditsStored: number; creditsShown: number } {
  const m = byId.get(id);
  if (!m) throw new Error(`unknown model ${id}`);
  const shown = Math.ceil(m.creditsPerUnit * units * 10) / 10;
  return { usd: m.usdPerUnit * units, creditsShown: shown, creditsStored: Math.round(shown * 10) };
}

/** A model must be proven before it is run in anyone's name. */
export function assertRunnable(id: string): ModelEntry {
  const m = byId.get(id);
  if (!m) throw new Error(`ไม่รู้จักโมเดล ${id}`);
  if (!m.verified) throw new Error(`โมเดล ${m.label} ยังไม่ผ่านการพิสูจน์ปลายทาง (submit → ได้ไฟล์จริง) จึงยังเปิดใช้ไม่ได้`);
  return m;
}

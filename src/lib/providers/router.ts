import { MODELS, ModelEntry, Tier } from './registry';
import type { VfxShot, VfxEngine } from '@/lib/vfx/types';

/**
 * Model routing (Phase 4). Picks among VERIFIED registry entries for a task by what the
 * caller values — the cheapest that meets a tier, or the best within a budget — using the
 * prices the bill set. It never invents an endpoint: everything it returns has been proved.
 */
const rank: Record<Tier, number> = { economy: 0, pro: 1, ultra: 2 };

export function candidates(task: string): ModelEntry[] {
  return MODELS.filter((m) => m.task === task && m.verified);
}

/** Cheapest verified model at or above `minTier` (economy by default). */
export function cheapest(task: string, minTier: Tier = 'economy'): ModelEntry | null {
  const list = candidates(task).filter((m) => rank[m.tier] >= rank[minTier]);
  return list.sort((a, b) => a.usdPerUnit - b.usdPerUnit)[0] || null;
}

/** Highest tier whose price per unit stays within `maxUsdPerUnit` (ties → cheaper). */
export function bestWithin(task: string, maxUsdPerUnit: number): ModelEntry | null {
  const list = candidates(task).filter((m) => m.usdPerUnit <= maxUsdPerUnit);
  return list.sort((a, b) => rank[b.tier] - rank[a.tier] || a.usdPerUnit - b.usdPerUnit)[0] || null;
}

export type Preference = 'economy' | 'balanced' | 'quality';

/**
 * Which VFX engine a shot should get. The matte path is cheap and keeps the person's
 * pixels but needs a clean cut-out; the O3 edit re-renders the frame and forgives moving
 * cameras, crowds and hard edges at ~10× the price. The shot notes from the analyser
 * (people count, camera) are the signal; the preference sets how readily we pay.
 */
export function recommendEngine(shot: Pick<VfxShot, 'analysis' | 'start' | 'end'>, pref: Preference): { engine: VfxEngine; reason: string } {
  const secs = shot.end - shot.start;
  const people = shot.analysis?.people ?? 1;
  const camera = (shot.analysis?.camera || 'unknown').toLowerCase();
  const moving = ['handheld', 'pan', 'tilt', 'dolly'].includes(camera);
  const o3Fits = secs >= 3 && secs <= 15;
  if (pref === 'economy' || !o3Fits) {
    return { engine: 'matte', reason: !o3Fits ? `ช็อต ${secs.toFixed(1)} วิ อยู่นอกช่วง 3–15 วิของ O3 edit` : 'โหมดประหยัด: ตัดคน+วางฉาก' };
  }
  if (pref === 'quality') return { engine: 'o3', reason: 'โหมดคุณภาพ: เรนเดอร์ทั้งเฟรมด้วย O3' };
  if (people >= 2) return { engine: 'o3', reason: `มีคน ${people} คนในเฟรม — การตัดคนหลายคนซ้อนกันมักหลุดขอบ` };
  if (moving) return { engine: 'o3', reason: `กล้อง${camera === 'handheld' ? 'ถือมือ' : 'เคลื่อนที่'} — ฉากหลังนิ่งจะดูผิดธรรมชาติ` };
  return { engine: 'matte', reason: 'คนเดียว กล้องนิ่ง — ตัดคน+วางฉากคุ้มกว่า 10 เท่า' };
}

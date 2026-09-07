import { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '@/lib/vfx/store';
import type { Tier } from '@/lib/providers/registry';

/**
 * Credit packages by tier (direction pivot: production, not classroom).
 *
 * Credits keep their meaning — 1 displayed credit ≈ $0.01 of billed model cost with a 15%
 * margin (credits = ⌈$ × 115⌉, see rates.ts). Packages differ in three things: how many
 * credits, the price per credit, and which MODEL TIERS the account may run.
 *   economy  — calibrated defaults (Kling 720p, Flux Dev, veed, lip-sync)
 *   pro      — O3 Standard, Motion Control character, Seedream, Sora 2, Wan …
 *   ultra    — O3 Pro/4K, O3 Video Edit, Veo 3, Flux Ultra, Nano Banana Pro, GPT Image …
 * A Studio/Production account reaches ultra; Starter and Creator do not, so a 10-second
 * VFX shot at $3–4 cannot surprise someone on a ฿590 plan.
 *
 * THB prices assume ≈ ฿34/USD; a credit is sold at ฿0.5–0.6 (cost ≈ ฿0.34 + margin).
 */
export interface CreditPackage {
  id: 'starter' | 'creator' | 'studio' | 'production';
  label: string;
  credits: number;
  price_thb: number;
  max_tier: Tier;
  blurb: string;
  /** what the credits buy at today's billed rates, for the sales page */
  examples: string[];
}

export const PACKAGES: CreditPackage[] = [
  { id: 'starter', label: 'Starter', credits: 1000, price_thb: 590, max_tier: 'economy', blurb: 'ทดลองและงานสั้น: โมเดลมาตรฐานทั้งหมด', examples: ['วิดีโอพูด 5 วิ (Kling 720p + ลิปซิงค์) ≈ 36 เครดิต → ~27 คลิป', 'ภาพ Flux Dev ≈ 3 เครดิต → ~330 ภาพ'] },
  { id: 'creator', label: 'Creator', credits: 3000, price_thb: 1590, max_tier: 'pro', blurb: 'ครีเอเตอร์: เพิ่ม O3 Standard, Scene Beat, Motion Control, Seedream, Sora 2', examples: ['Scene Beat 12 วิ ≈ 145 เครดิต → ~20 บีต', 'VFX ตัดคน+วางฉาก 10 วิ ≈ 24 เครดิต → ~125 ช็อต'] },
  { id: 'studio', label: 'Studio', credits: 10000, price_thb: 4990, max_tier: 'ultra', blurb: 'สตูดิโอ: ทุกโมเดลรวม ultra (O3 Pro/4K, O3 Edit, Veo 3, Flux Ultra, GPT Image)', examples: ['O3 Video Edit 10 วิ ≈ 191 เครดิต → ~52 ช็อต', 'O3 4K 5 วิ ≈ 240 เครดิต → ~41 คลิป'] },
  { id: 'production', label: 'Production', credits: 30000, price_thb: 13900, max_tier: 'ultra', blurb: 'โปรดักชั่น: ทุกโมเดล + Film Mode + โหมดชุด ราคาต่อเครดิตต่ำสุด', examples: ['หนังสั้น 2 นาที VFX ครบเลเยอร์ ≈ 4,000–5,000 เครดิต', 'เครดิตละ ฿0.46'] }
];

export interface AccountRecord {
  email: string;
  tier: Tier;                 // highest model tier the account may run
  package_id?: CreditPackage['id'];
  history: { at: string; package_id: string; credits: number; price_thb: number; by: string; note?: string }[];
  updated_at: string;
}

const BUCKET = 'kruth-ai-assets';
const accountPath = (email: string) => `billing/accounts/${email.toLowerCase()}.json`;

export async function loadAccount(email: string, supabase: SupabaseClient = serviceClient()): Promise<AccountRecord> {
  const { data } = await supabase.storage.from(BUCKET).download(accountPath(email));
  if (data) { try { return JSON.parse(await data.text()); } catch { /* fall through */ } }
  // No record yet: existing whitelisted users keep what they had — everything (they were
  // never tier-gated). New accounts get a package before they have a tier.
  return { email: email.toLowerCase(), tier: 'ultra', history: [], updated_at: new Date(0).toISOString() };
}

export async function saveAccount(rec: AccountRecord, supabase: SupabaseClient = serviceClient()): Promise<void> {
  rec.updated_at = new Date().toISOString();
  const { error } = await supabase.storage.from(BUCKET).upload(accountPath(rec.email), Buffer.from(JSON.stringify(rec)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกบัญชีไม่สำเร็จ: ${error.message}`);
}

/** Grant a package: add its credits to the whitelist balance and set the account's tier. */
export async function grantPackage(email: string, packageId: CreditPackage['id'], by: string, note?: string, supabase: SupabaseClient = serviceClient()): Promise<{ account: AccountRecord; newBalance: number }> {
  const pkg = PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw new Error('ไม่รู้จักแพ็กเกจ');
  const e = email.toLowerCase();
  const { data: wl, error } = await supabase.from('whitelist').select('generation_limit').eq('email', e).maybeSingle();
  if (error) throw new Error('อ่านยอดเครดิตไม่สำเร็จ');
  if (!wl) throw new Error('ผู้ใช้ยังไม่อยู่ในรายชื่อ — เพิ่มสิทธิ์ก่อนแล้วค่อยให้แพ็กเกจ');
  const newBalance = (wl.generation_limit || 0) + pkg.credits * 10;
  const { error: upErr } = await supabase.from('whitelist').update({ generation_limit: newBalance }).eq('email', e);
  if (upErr) throw new Error('เพิ่มเครดิตไม่สำเร็จ');
  const account = await loadAccount(e, supabase);
  account.tier = pkg.max_tier;
  account.package_id = pkg.id;
  account.history.unshift({ at: new Date().toISOString(), package_id: pkg.id, credits: pkg.credits, price_thb: pkg.price_thb, by, note });
  await saveAccount(account, supabase);
  return { account, newBalance };
}

const rank: Record<Tier, number> = { economy: 0, pro: 1, ultra: 2 };

/** May this account run a model of the given tier? Super-admin always may. */
export async function assertTier(email: string, needed: Tier, supabase: SupabaseClient = serviceClient()): Promise<void> {
  if (email.toLowerCase() === 'whootthira@gmail.com') return;
  const acc = await loadAccount(email, supabase);
  if (rank[acc.tier] < rank[needed]) {
    const pkg = PACKAGES.find((p) => rank[p.max_tier] >= rank[needed]);
    throw new Error(`โมเดลระดับ ${needed} ต้องใช้แพ็กเกจ ${pkg?.label || needed} ขึ้นไป (บัญชีนี้อยู่ระดับ ${acc.tier})`);
  }
}

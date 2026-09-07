import { geminiUrl, geminiText } from '@/lib/gemini';
import { audit } from '@/lib/audit';

/**
 * Prompt screening before anything is sent to a provider (Content Policy §2).
 * Two layers: a fast local check for the categories that must never reach a model, then
 * a Gemini classification for the rest. Fails CLOSED on the local layer and OPEN on the
 * model layer (a Gemini outage must not stop ordinary work — the provider's own filter
 * still stands behind it). Every block is audited.
 */
export const POLICY_VERSION = '2026-09-07';

export type BlockCategory = 'minor_sexual' | 'real_person_sexual' | 'sexual_violence' | 'impersonation' | 'harassment' | 'extremist_violence';

const LOCAL_PATTERNS: { cat: BlockCategory; re: RegExp }[] = [
  // sexual context + minor terms (Thai/English); deliberately broad — this layer never goes to a model
  { cat: 'minor_sexual', re: /(เด็ก|ผู้เยาว์|นักเรียน(?:หญิง|ชาย)?|วัยรุ่น|เยาวชน|\bloli\b|\bshota\b|\bminor\b|\bchild\b|\bteen(?:age)?\b|\bschoolgirl\b|\bunderage\b|\b1[0-7]\s*(?:ปี|years?|yo)\b)[\s\S]{0,80}(เปลือย|โป๊|เซ็กส์|ร่วมเพศ|ลามก|อนาจาร|nude|naked|sex|porn|erotic|nsfw|explicit|lewd)|(เปลือย|โป๊|เซ็กส์|ร่วมเพศ|ลามก|อนาจาร|nude|naked|sex|porn|erotic|nsfw|explicit|lewd)[\s\S]{0,80}(เด็ก|ผู้เยาว์|นักเรียน(?:หญิง|ชาย)?|วัยรุ่น|เยาวชน|\bloli\b|\bshota\b|\bminor\b|\bchild\b|\bteen(?:age)?\b|\bschoolgirl\b|\bunderage\b)/i },
  { cat: 'sexual_violence', re: /(ข่มขืน|บังคับ(?:ให้)?(?:มีเซ็กส์|ร่วมเพศ)|\brape\b|\bnon-?consensual\b|\bforced sex\b|\bmolest)/i }
];

export interface ModerationResult {
  allowed: boolean;
  category?: BlockCategory;
  reason?: string;
  layer: 'local' | 'model' | 'none';
}

const BLOCK_MESSAGE: Record<BlockCategory, string> = {
  minor_sexual: 'คำขอนี้ขัดนโยบายเนื้อหา (เนื้อหาทางเพศที่เกี่ยวข้องกับผู้เยาว์) — ระบบไม่สร้างและบันทึกเหตุการณ์ไว้',
  real_person_sexual: 'คำขอนี้ขัดนโยบายเนื้อหา (เนื้อหาทางเพศของบุคคลจริง) — ระบบไม่สร้าง',
  sexual_violence: 'คำขอนี้ขัดนโยบายเนื้อหา (ความรุนแรงทางเพศ/การบังคับ) — ระบบไม่สร้าง',
  impersonation: 'คำขอนี้ขัดนโยบายเนื้อหา (แอบอ้างบุคคลจริงเพื่อหลอกลวง) — ระบบไม่สร้าง',
  harassment: 'คำขอนี้ขัดนโยบายเนื้อหา (คุกคาม/ทำให้เสื่อมเสีย) — ระบบไม่สร้าง',
  extremist_violence: 'คำขอนี้ขัดนโยบายเนื้อหา (ความรุนแรงสุดโต่ง) — ระบบไม่สร้าง'
};

export function blockMessage(cat: BlockCategory) { return BLOCK_MESSAGE[cat]; }

/** Screen free text (prompt, script, brief). `context` names the route for the audit trail. */
export async function moderateText(text: string, context: { route: string; user_email?: string }): Promise<ModerationResult> {
  const t = (text || '').trim();
  if (!t) return { allowed: true, layer: 'none' };

  for (const p of LOCAL_PATTERNS) {
    if (p.re.test(t)) {
      await audit({ kind: 'moderation_block', actor: context.user_email || 'anonymous', target: context.route, detail: { category: p.cat, layer: 'local', policy: POLICY_VERSION, excerpt: t.slice(0, 120) } });
      return { allowed: false, category: p.cat, reason: BLOCK_MESSAGE[p.cat], layer: 'local' };
    }
  }

  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return { allowed: true, layer: 'none' };
  try {
    const res = await fetch(`${geminiUrl()}?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `You are a content-policy classifier for a video/image production tool. Classify the user's generation request below. Block ONLY these categories: minor_sexual (sexual content involving anyone under 18 or of ambiguous age), real_person_sexual (sexual content depicting a real identifiable person), sexual_violence (rape, coercion, non-consent), impersonation (pretending to be a real person to deceive), harassment (degrading a specific real person), extremist_violence (glorifying terrorism/mass violence). Ordinary romance, adults kissing, violence in fiction, medical or educational content are ALLOWED. Reply with JSON only: {"allowed": true|false, "category": "<one of the categories or null>", "why": "<short>"}.\n\nRequest:\n"""${t.slice(0, 2000)}"""` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } }
      })
    });
    if (!res.ok) return { allowed: true, layer: 'none' };
    const m = geminiText(await res.json()).match(/\{[\s\S]*\}/);
    if (!m) return { allowed: true, layer: 'none' };
    const j = JSON.parse(m[0]);
    const cat = j.category as BlockCategory | null;
    if (j.allowed === false && cat && BLOCK_MESSAGE[cat]) {
      await audit({ kind: 'moderation_block', actor: context.user_email || 'anonymous', target: context.route, detail: { category: cat, layer: 'model', why: String(j.why || '').slice(0, 200), policy: POLICY_VERSION, excerpt: t.slice(0, 120) } });
      return { allowed: false, category: cat, reason: BLOCK_MESSAGE[cat], layer: 'model' };
    }
    return { allowed: true, layer: 'model' };
  } catch {
    return { allowed: true, layer: 'none' };
  }
}

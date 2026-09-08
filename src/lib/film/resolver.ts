import type { Film, FilmScene, StyleBible, MasterAsset } from './types';

/**
 * Style Resolver (F1): bible → scene override → shot override, lower layers winning only
 * on the keys they set; plus the locked masters the scene refers to. The snapshot is what a
 * shot is generated and graded with, and is stored on the shot for audit.
 * (Act level arrives with the hierarchy in F2; the merge order already leaves room for it.)
 */
export interface EffectiveStyle {
  bible_version: number;
  palette: string[];
  lut_url?: string;
  lut_name?: string;
  lighting_rules: StyleBible['lighting_rules'];
  lens: StyleBible['lens'];
  aspect: StyleBible['aspect'];
  fps: StyleBible['fps'];
  exposure_stops: number;
  delta_e_threshold: number;
  location: { master_id: string; version: number; name: string; plate_url: string } | null;
  anchor_frame_url?: string;
  pinned_models: Film['pinned_models'];
  /** the neutral-grade instruction every generative layer receives — no colour words */
  neutral_prompt_suffix: string;
  resolved_at: string;
}

export function resolveEffectiveStyle(film: Film, scene: FilmScene, shotOverride: Partial<FilmScene['style_override']> = {}): EffectiveStyle {
  const b = film.bible;
  // film → act → scene → shot: each layer wins only on the keys it sets
  const ao = (film.acts || []).find((a) => a.id === scene.act_id)?.style_override || {};
  const so = scene.style_override || {};
  const master = film.masters.find((m) => m.id === scene.location_master_id) || null;
  const lighting = { ...b.lighting_rules, ...(ao.lighting_rules || {}), ...(so.lighting_rules || {}), ...(shotOverride.lighting_rules || {}) };
  const lens = { ...b.lens, ...(ao.lens || {}), ...(so.lens || {}), ...(shotOverride.lens || {}) };
  return {
    bible_version: b.version,
    palette: b.palette,
    lut_url: shotOverride.lut_url ?? so.lut_url ?? ao.lut_url ?? b.lut_url,
    lut_name: shotOverride.lut_name ?? so.lut_name ?? ao.lut_name ?? b.lut_name,
    lighting_rules: lighting,
    lens,
    aspect: b.aspect,
    fps: b.fps,
    // exposure stops add up across layers (an act at -1 and a scene at +0.5 → -0.5)
    exposure_stops: (ao.exposure_stops || 0) + (so.exposure_stops || 0) + (shotOverride.exposure_stops || 0),
    delta_e_threshold: b.delta_e_threshold,
    location: master ? { master_id: master.id, version: master.version, name: master.name, plate_url: master.sheet_urls[0] } : null,
    anchor_frame_url: scene.anchor_frame_url,
    pinned_models: film.pinned_models,
    neutral_prompt_suffix: `neutral colour grade, ${lighting.key}, fill ${lighting.fill}, contrast ratio ${lighting.ratio}, ${lens.focal} lens look, no colour cast, no stylised tint`,
    resolved_at: new Date().toISOString()
  };
}

/** The spec's hard rule: Film Mode jobs reference locked masters only. */
export function requireLockedMaster(film: Film, masterId: string, kind?: MasterAsset['kind']): MasterAsset {
  const m = film.masters.find((x) => x.id === masterId);
  if (!m) throw new Error('ไม่พบ master asset ที่อ้างถึง — Film Mode รับเฉพาะ reference จาก master assets ของหนังเรื่องนี้');
  if (kind && m.kind !== kind) throw new Error(`master "${m.name}" เป็นชนิด ${m.kind} ไม่ใช่ ${kind}`);
  if (!m.locked) throw new Error(`master "${m.name}" ยังไม่ถูกล็อก — ล็อกก่อนจึงใช้สร้างช็อตได้`);
  if (!m.sheet_urls.length) throw new Error(`master "${m.name}" ยังไม่มีภาพ`);
  return m;
}

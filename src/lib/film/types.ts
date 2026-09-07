/**
 * Film Mode (F1) — the film document.
 *
 * Principle from the spec: consistency lives in LOCKED ASSETS, not in prompts. A film owns a
 * Style Bible (data, not prose) and master assets; every scene names a locked location
 * master, every shot is generated against that master's plate with a neutral grade, and the
 * colour pipeline is deterministic afterwards: LUT from the Bible + match to the scene's
 * approved anchor frame. Pre-grade and post-grade outputs are kept apart so a new LUT
 * re-grades the whole scene with no generative job.
 *
 * F1 = bible + masters + resolver + Bible Studio + colour pipeline. Acts, chaining,
 * consistency worker, continuity board and pinning migration are F2–F5.
 */

export interface StyleBible {
  version: number;
  palette: string[];                      // hex colours the film lives in
  lut_url?: string;                       // .cube LUT applied to every graded shot
  lut_name?: string;
  lighting_rules: { key: string; fill: string; ratio: string; tone: string };
  lens: { focal: string; grain: 'none' | 'fine' | 'medium' | 'heavy'; vignette: number };
  aspect: '16:9' | '9:16' | '1:1' | '2.39:1';
  fps: 24 | 25 | 30;
  /** how far a graded shot may sit from the anchor before it is flagged (CIE76 ΔE of mean colour) */
  delta_e_threshold: number;
  locked_at?: string;
}

export type MasterKind = 'character' | 'location' | 'prop';

export interface MasterAsset {
  id: string;
  kind: MasterKind;
  name: string;
  /** approved images, several angles; [0] is the hero/plate */
  sheet_urls: string[];
  /** character masters from a real person carry the same consent record as VFX Studio */
  consent_id?: string;
  /** provider-side element id when one exists (Kling elements etc.) */
  element_ref?: string;
  version: number;
  locked: boolean;
  /** shots that used each version — a used version is never edited in place */
  used_by: { version: number; shot_id: string }[];
  created_at: string;
}

export interface FilmShot {
  id: string;
  order: number;
  /** the VFX Studio project/shot that generated it (matte engine, plate = location master) */
  vfx_project_id: string;
  vfx_shot_id: string;
  master_versions: { master_id: string; version: number }[];
  /** what the shot was generated with — audit snapshot from the resolver */
  effective_style: Record<string, any>;
  status: 'draft' | 'processing' | 'ready' | 'graded' | 'failed';
  pre_grade_url?: string;
  post_grade_url?: string;
  /** measured after grade against the scene anchor */
  delta_e?: number;
  passed?: boolean;
  error?: string;
  updated_at: string;
}

export interface FilmScene {
  id: string;
  order: number;
  name: string;
  location_master_id: string;
  time_of_day: string;
  weather: string;
  /** the approved frame every other shot in the scene is matched to */
  anchor_frame_url?: string;
  anchor_from_shot_id?: string;
  style_override: Partial<Pick<StyleBible, 'lut_url' | 'lut_name' | 'lighting_rules' | 'lens'>> & { exposure_stops?: number };
  shots: FilmShot[];
}

export interface Film {
  id: string;
  user_email: string;
  user_id: string;
  title: string;
  bible: StyleBible;
  bible_history: { version: number; bible: StyleBible; at: string }[];
  masters: MasterAsset[];
  scenes: FilmScene[];
  /** provider + model pinned per task at film creation (F1 records; F5 migrates) */
  pinned_models: Record<string, { model_id: string; endpoint: string; pinned_at: string }>;
  status: 'draft' | 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export const DEFAULT_BIBLE: StyleBible = {
  version: 1,
  palette: ['#1A1A1A', '#D4AF37', '#F5F0E6', '#3B5B7A'],
  lighting_rules: { key: 'soft window light, camera left', fill: 'low, warm bounce', ratio: '3:1', tone: 'neutral' },
  lens: { focal: '35mm', grain: 'fine', vignette: 0.1 },
  aspect: '16:9',
  fps: 25,
  delta_e_threshold: 6
};

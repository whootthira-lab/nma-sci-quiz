/**
 * VFX Studio (Phase 1) — the project document.
 *
 * One project = one piece of footage cut into shots; each shot carries the layers the
 * spec names (matte · background · grade · composite). One layer = one job = one artifact,
 * and an artifact is kept when a sibling layer is redone (a new background never re-runs
 * the matte). The document is versioned per layer so a redo can be compared and rolled back.
 */

export type VfxEngine = 'matte' | 'o3';
export type VfxGrade = 'none' | 'warm' | 'cool' | 'cinematic' | 'match';
export type VfxLayerType = 'matte' | 'background' | 'fx' | 'grade' | 'composite' | 'edit';
export type VfxLayerStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';
export type VfxShotStatus = 'draft' | 'processing' | 'review' | 'approved' | 'failed';
export type VfxProjectStatus = 'draft' | 'planned' | 'processing' | 'review' | 'exported';

export interface VfxLayerOutput {
  /** matte: the person clip (colour) and its alpha clip */
  color_url?: string;
  alpha_url?: string;
  /** background: the environment image */
  image_url?: string;
  /** composite / edit: the finished shot */
  video_url?: string;
}

export interface VfxLayer {
  id: string;
  type: VfxLayerType;
  enabled: boolean;
  /** free-form per type: background.prompt, grade.preset, edit.prompt … */
  params: Record<string, any>;
  /** registry model id that produced the current output, if a model was involved */
  model_id?: string;
  cost_credits: number;
  version: number;
  status: VfxLayerStatus;
  /** the generations row (fal request id) carrying this layer's job, when queued */
  job_request_id?: string;
  output: VfxLayerOutput;
  /** earlier outputs, newest first, for rollback */
  history: { version: number; output: VfxLayerOutput; params: Record<string, any>; at: string }[];
  error?: string;
  updated_at: string;
}

export interface VfxShot {
  id: string;
  order: number;
  /** seconds into the footage */
  start: number;
  end: number;
  /** the trimmed source segment (uploaded), and a poster frame */
  clip_url: string;
  thumb_url?: string;
  width: number;
  height: number;
  fps: number;
  /** what the VLM saw (people, camera, light) — advisory, never blocks */
  analysis?: { summary: string; people: number; camera: string; lighting: string };
  layers: VfxLayer[];
  status: VfxShotStatus;
  output_url?: string;
  error?: string;
}

export interface VfxProject {
  id: string;
  user_email: string;
  user_id: string;
  name: string;
  footage_url: string;
  footage: { seconds: number; width: number; height: number; fps: number };
  reference_urls: string[];
  /** the user's brief for the orchestrator */
  instruction: string;
  engine: VfxEngine;
  grade: VfxGrade;
  shots: VfxShot[];
  status: VfxProjectStatus;
  /** credits shown at confirm time and charged — must agree (spec acceptance) */
  estimated_credits: number;
  charged_credits: number;
  export_url?: string;
  created_at: string;
  updated_at: string;
}

export const VFX_PHASE1_LIMITS = {
  footageMaxSeconds: 60,
  shotMinSeconds: 1.5,
  shotMaxSeconds: 15, // O3 edit cap; the matte path could go longer but shots stay short
  maxShots: 12,
  maxReferences: 4
};

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fetchToFile, probeVideo } from './composite';
import { geminiUrl, geminiText } from '@/lib/gemini';

/**
 * VLM quality check on a finished shot (Phase 3 guardrail). Samples three frames and asks
 * the model for the defects the spec names — cut-out edges, lighting mismatch, frame jumps,
 * identity drift. Advisory only: flags are attached to the shot for the reviewer, nothing
 * is blocked (false positives must not stall production in this phase).
 */
export interface QaReport {
  flags: string[];          // machine keys: edge_halo | lighting_mismatch | frame_jump | identity_drift | artifact
  notes: string;            // one Thai sentence for the reviewer
  score: number;            // 1–5, 5 = clean
  checked_at: string;
}

function grab(file: string, at: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegInstaller.path, ['-hide_banner', '-y', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', out], (err) => (err ? reject(err) : resolve()));
  });
}

export async function qaShot(videoUrl: string, context: { before?: string; identityUrl?: string }): Promise<QaReport | null> {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx_qa_'));
  try {
    const file = path.join(dir, 'shot.mp4');
    await fetchToFile(videoUrl, file);
    const info = await probeVideo(file);
    const secs = info.seconds || 5;
    const times = [0.3, secs / 2, Math.max(0.3, secs - 0.4)];
    const parts: any[] = [{
      text: `You are a VFX QC supervisor. These are three frames (start, middle, end) of one finished shot in which a real person was placed into a new environment${context.identityUrl ? ' and their appearance was edited to match a reference identity (last image)' : ''}.
Check for: (1) cut-out edges — halos, hard or eaten edges around hair/shoulders; (2) lighting mismatch — person lit from a different direction/colour than the background; (3) frame jumps — appearance changing between frames; (4) identity drift — face not matching the reference; (5) other artifacts — warped hands, text, duplicated limbs.
Reply with JSON only: {"flags": [subset of "edge_halo","lighting_mismatch","frame_jump","identity_drift","artifact"], "score": <1-5, 5 = clean>, "notes": "<one sentence in Thai for the reviewer>"}.`
    }];
    for (let i = 0; i < times.length; i++) {
      const f = path.join(dir, `f${i}.jpg`);
      await grab(file, times[i], f);
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
    }
    if (context.identityUrl) {
      const r = await fetch(context.identityUrl);
      if (r.ok) parts.push({ inline_data: { mime_type: r.headers.get('content-type')?.includes('png') ? 'image/png' : 'image/jpeg', data: Buffer.from(await r.arrayBuffer()).toString('base64') } });
    }
    const res = await fetch(`${geminiUrl()}?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } })
    });
    if (!res.ok) return null;
    const text = geminiText(await res.json());
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const allowed = ['edge_halo', 'lighting_mismatch', 'frame_jump', 'identity_drift', 'artifact'];
    return {
      flags: Array.isArray(j.flags) ? j.flags.filter((f: any) => allowed.includes(f)) : [],
      notes: String(j.notes || ''),
      score: Math.min(5, Math.max(1, Number(j.score) || 3)),
      checked_at: new Date().toISOString()
    };
  } catch (e) {
    console.warn('[VFX QA] skipped:', (e as any)?.message || e);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Public-figure screen for a face reference (Phase 3 guardrail): the spec refuses
 * references that depict a public person. Advisory answer from the VLM; the caller blocks
 * on "yes". Errors return null so an outage does not silently pass a face through —
 * the caller treats null as "could not check" and asks the user to retry.
 */
export async function isPublicFigure(imageUrl: string): Promise<{ publicFigure: boolean; who: string } | null> {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return null;
  try {
    const r = await fetch(imageUrl);
    if (!r.ok) return null;
    const data = Buffer.from(await r.arrayBuffer()).toString('base64');
    const res = await fetch(`${geminiUrl()}?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: 'Does this image depict a recognizable public figure (politician, celebrity, athlete, royalty, well-known executive or influencer)? Reply with JSON only: {"public_figure": true|false, "who": "<name or empty>"}. If unsure, answer false.' },
        { inline_data: { mime_type: r.headers.get('content-type')?.includes('png') ? 'image/png' : 'image/jpeg', data } }
      ] }], generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } })
    });
    if (!res.ok) return null;
    const m = geminiText(await res.json()).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return { publicFigure: j.public_figure === true, who: String(j.who || '') };
  } catch {
    return null;
  }
}

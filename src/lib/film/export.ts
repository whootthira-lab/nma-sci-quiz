import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Film, FilmScene, FilmShot } from './types';
import { orderedScenes } from './continuity';
import { fetchToFile, probeVideo } from '@/lib/vfx/composite';

/**
 * Film export (F5): the cut as data an NLE can open, not only as a flattened MP4.
 *   - CMX3600 EDL (one video event per shot, sequential record timecode, source = the shot file)
 *   - Final Cut Pro 7 XML (xmeml v5) — Premiere, Resolve and FCP-derivatives import it
 *   - manifest.json: file name ↔ download URL ↔ scene/shot ↔ models/bible/master versions
 *   - QA report (JSON + CSV): ΔE / histogram / style / continuity / retries per shot
 * File names are stable (S01_SH02.mp4) so a re-export replaces clips in place in the NLE.
 */
export interface ExportItem {
  scene: FilmScene; shot: FilmShot; name: string; url: string; seconds: number; width: number; height: number; fps: number;
}

export function pickShots(film: Film, scope: 'film' | 'act' | 'scene', scopeId: string | undefined, includeUnapproved: boolean): { scene: FilmScene; shot: FilmShot }[] {
  const scenes = orderedScenes(film).filter((s) => scope === 'film' || (scope === 'act' ? s.act_id === scopeId : s.id === scopeId));
  const out: { scene: FilmScene; shot: FilmShot }[] = [];
  for (const scene of scenes) {
    for (const shot of [...scene.shots].sort((a, b) => a.order - b.order)) {
      if (!(shot.post_grade_url || shot.pre_grade_url)) continue;
      if (shot.status === 'processing' || shot.status === 'failed') continue;
      if (!includeUnapproved && shot.status !== 'approved') continue;
      out.push({ scene, shot });
    }
  }
  return out;
}

/** act + scene + shot: scene numbers restart per act, so the act keeps names unique */
export const clipName = (film: Film, scene: FilmScene, shot: FilmShot) => `A${String(film.acts.find((a) => a.id === scene.act_id)?.order || 1).padStart(2, '0')}_S${String(scene.order).padStart(2, '0')}_SH${String(shot.order).padStart(2, '0')}.mp4`;

/** download each clip once to read its real length/size (ffmpeg banner; no ffprobe here) */
export async function measureItems(film: Film, picked: { scene: FilmScene; shot: FilmShot }[], resolve: (ref: string) => Promise<string>): Promise<ExportItem[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film_exp_'));
  try {
    const items: ExportItem[] = [];
    for (const { scene, shot } of picked) {
      const ref = shot.post_grade_url || shot.pre_grade_url!;
      const f = path.join(dir, `${shot.id}.mp4`);
      await fetchToFile(ref, f);
      const p = await probeVideo(f);
      items.push({ scene, shot, name: clipName(film, scene, shot), url: await resolve(ref), seconds: p.seconds, width: p.width, height: p.height, fps: p.fps || film.bible.fps });
      fs.rmSync(f, { force: true });
    }
    return items;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function timecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const ff = f % fps; const s = Math.floor(f / fps);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

export function buildEdl(title: string, items: ExportItem[], fps: number): string {
  const lines = [`TITLE: ${title.replace(/[\r\n]+/g, ' ').slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 3600 * fps; // records start at 01:00:00:00, the usual convention
  items.forEach((it, i) => {
    const len = Math.max(1, Math.round(it.seconds * fps));
    const reel = it.name.replace(/\.mp4$/, '').replace(/_/g, '').slice(0, 8).padEnd(8, ' ');
    lines.push(`${String(i + 1).padStart(3, '0')}  ${reel} V     C        ${timecode(0, fps)} ${timecode(len, fps)} ${timecode(rec, fps)} ${timecode(rec + len, fps)}`);
    lines.push(`* FROM CLIP NAME: ${it.name}`);
    lines.push(`* COMMENT: scene ${it.scene.order} "${it.scene.name}" shot ${it.shot.order} · status ${it.shot.status}${typeof it.shot.delta_e === 'number' ? ` · ΔE ${it.shot.delta_e}` : ''}`);
    lines.push('');
    rec += len;
  });
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildFcpXml(title: string, items: ExportItem[], fps: number): string {
  const w = items[0]?.width || 1920; const h = items[0]?.height || 1080;
  const ntsc = fps === 30 || fps === 24 ? 'FALSE' : 'FALSE';
  let start = 0;
  const clips = items.map((it, i) => {
    const len = Math.max(1, Math.round(it.seconds * fps));
    const id = `clip-${i + 1}`;
    const x = `      <clipitem id="${id}">
        <name>${esc(it.name)}</name>
        <duration>${len}</duration>
        <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>
        <start>${start}</start><end>${start + len}</end>
        <in>0</in><out>${len}</out>
        <file id="file-${i + 1}">
          <name>${esc(it.name)}</name>
          <pathurl>file://localhost/${esc(it.name)}</pathurl>
          <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>
          <duration>${len}</duration>
          <media><video><samplecharacteristics><width>${it.width || w}</width><height>${it.height || h}</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media>
        </file>
        <comments><mastercomment1>scene ${it.scene.order} ${esc(it.scene.name)} · shot ${it.shot.order} · ${it.shot.status}</mastercomment1></comments>
      </clipitem>`;
    start += len;
    return x;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="seq-1">
    <name>${esc(title)}</name>
    <duration>${start}</duration>
    <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>
    <timecode><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><string>01:00:00:00</string><frame>${3600 * fps}</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics><width>${w}</width><height>${h}</height><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate></samplecharacteristics></format>
        <track>
${clips.join('\n')}
        </track>
      </video>
      <audio><track/></audio>
    </media>
  </sequence>
</xmeml>
`;
}

export function buildQaReport(film: Film, items: ExportItem[]) {
  const rows = items.map((it) => ({
    file: it.name, scene: it.scene.order, scene_name: it.scene.name, shot: it.shot.order, status: it.shot.status, seconds: +it.seconds.toFixed(2),
    bible_version: it.shot.effective_style?.graded_with?.bible_version ?? it.shot.effective_style?.bible_version ?? null,
    lut: it.shot.effective_style?.graded_with?.lut ?? null,
    delta_e: it.shot.qa?.color_delta_e ?? it.shot.delta_e ?? null,
    delta_e_threshold: it.shot.qa?.threshold_used.delta_e ?? film.bible.delta_e_threshold,
    histogram: it.shot.qa?.histogram_score ?? null,
    style_distance: it.shot.qa?.style_distance ?? null,
    style_notes: it.shot.qa?.style_notes ?? '',
    qa_passed: it.shot.qa?.passed ?? it.shot.passed ?? null,
    auto_retries: it.shot.qa?.auto_retry_count ?? 0,
    continuity_passed: it.shot.continuity?.passed ?? null,
    continuity_issues: it.shot.continuity ? it.shot.continuity.per_subject.flatMap((p) => p.issues).join(' / ') : '',
    masters: it.shot.master_versions.map((m) => `${film.masters.find((x) => x.id === m.master_id)?.name || m.master_id} v${m.version}`).join('; '),
    models: Object.entries((it.shot.effective_style?.pinned_models || film.pinned_models) as Record<string, any>).map(([k, v]) => `${k}=${v.model_id}`).join('; '),
    chained: !!it.shot.chain_frame_url
  }));
  const measured = rows.filter((r) => typeof r.delta_e === 'number');
  const summary = {
    film: film.title, film_id: film.id, generated_at: new Date().toISOString(), bible_version: film.bible.version, delta_e_threshold: film.bible.delta_e_threshold,
    shots: rows.length, seconds: +rows.reduce((s, r) => s + r.seconds, 0).toFixed(2),
    mean_delta_e: measured.length ? +(measured.reduce((s, r) => s + (r.delta_e as number), 0) / measured.length).toFixed(2) : null,
    qa_flagged: rows.filter((r) => r.qa_passed === false).length,
    continuity_flagged: rows.filter((r) => r.continuity_passed === false).length,
    pinned_models: film.pinned_models
  };
  const cols = Object.keys(rows[0] || { file: '' });
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => { const v = (r as any)[c]; const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(','))].join('\n');
  return { json: { summary, shots: rows }, csv };
}

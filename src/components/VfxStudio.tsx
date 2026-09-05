'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { uploadToStorage } from '@/lib/supabase-db';
import type { VfxProject, VfxShot, VfxEngine, VfxGrade } from '@/lib/vfx/types';
import { Layers, Loader2, CheckCircle2, AlertCircle, Film, Image as ImageIcon, Wand2, Scissors, Sparkles, RefreshCw, Download, ChevronRight, FolderOpen, Trash2 } from 'lucide-react';

/**
 * VFX Studio — Phase 1. Four steps on one project:
 *   1 Footage + references + brief → analysed into shots (no credits)
 *   2 Plan: per-shot layers, prompts, engine, grade, price → confirm (charges) → run
 *   3 Review: before/after per shot, redo the background alone, regrade, approve
 *   4 Export: join approved shots
 * Jobs finish on the server; this page only reads the project document.
 */

const ENGINES: { id: VfxEngine; label: string; blurb: string; perSec: number }[] = [
  { id: 'matte', label: 'ตัดคน + วางฉากใหม่', blurb: 'veed ตัดคนทุกเฟรม → วางบนภาพฉากที่ระบบสร้าง · gen ใหม่เฉพาะฉากหลังได้โดยไม่ตัดคนซ้ำ', perSec: 2 },
  { id: 'o3', label: 'Kling O3 Edit (อัลตร้า)', blurb: 'AI เรนเดอร์ช็อตใหม่ทั้งเฟรม แสงเงากลมกลืน · ช็อต 3–15 วิ', perSec: 19 }
];
const GRADES: { id: VfxGrade; label: string }[] = [
  { id: 'none', label: 'ไม่ปรับสี' }, { id: 'warm', label: 'อุ่น' }, { id: 'cool', label: 'เย็น' }, { id: 'cinematic', label: 'ซีเนมาติก' }
];

const statusLabel: Record<string, string> = {
  draft: 'ร่าง', planned: 'วางแผนแล้ว', processing: 'กำลังสร้าง', review: 'รอตรวจ', approved: 'อนุมัติแล้ว', failed: 'ล้มเหลว', exported: 'ส่งออกแล้ว',
  pending: 'รอ', done: 'เสร็จ', skipped: 'ข้าม'
};
const layerLabel: Record<string, string> = { matte: 'ตัดคน', background: 'ฉากหลัง', grade: 'ปรับสี', composite: 'ประกอบ', edit: 'O3 edit' };

export default function VfxStudio() {
  const { user } = useAuth();
  const email = user?.email || '';
  const [projects, setProjects] = useState<any[]>([]);
  const [project, setProject] = useState<VfxProject | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState('');

  // step 1 form
  const [footageFile, setFootageFile] = useState<File | null>(null);
  const [footagePreview, setFootagePreview] = useState('');
  const [footageUrl, setFootageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [refUrls, setRefUrls] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [engine, setEngine] = useState<VfxEngine>('matte');
  const [grade, setGrade] = useState<VfxGrade>('none');
  // step 2 edits
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  // step 3 edits
  const [redoPrompt, setRedoPrompt] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = async (path: string, body: any) => {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, user_email: email, user_id: user?.id || '' }) });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'คำขอไม่สำเร็จ');
    return j;
  };

  const loadList = useCallback(async () => {
    if (!email) return;
    try {
      const r = await fetch(`/api/vfx/projects?email=${encodeURIComponent(email)}`).then((x) => x.json());
      if (r.success) setProjects(r.projects);
    } catch { /* list is a convenience */ }
  }, [email]);
  useEffect(() => { loadList(); }, [loadList]);

  const openProject = async (id: string) => {
    setError('');
    const r = await fetch(`/api/vfx/projects?email=${encodeURIComponent(email)}&id=${id}`).then((x) => x.json());
    if (r.success) {
      setProject(r.project);
      setPrompts(Object.fromEntries(r.project.shots.map((s: VfxShot) => [s.id, s.layers.find((l) => l.type === 'background' || l.type === 'edit')?.params?.prompt || ''])));
      setConfirmed(false);
    } else setError(r.error || 'เปิดโปรเจกต์ไม่ได้');
  };

  // While any shot is processing, refresh the document — jobs finish on the server.
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!project || !project.shots.some((s) => s.status === 'processing')) return;
    pollRef.current = setTimeout(async () => {
      try {
        // Nudge the status route for each in-flight layer job (the cron driver also does this)
        for (const s of project.shots) for (const l of s.layers) {
          if (l.status === 'processing' && l.job_request_id) {
            fetch('/api/video-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: l.job_request_id, videoPath: `vfx_shots/${email}/${project.id}/${s.id}_${l.type}.mp4`, modelType: 'vfx', storageProvider: 'supabase' }) }).catch(() => {});
          }
        }
        const r = await fetch(`/api/vfx/projects?email=${encodeURIComponent(email)}&id=${project.id}`).then((x) => x.json());
        if (r.success) setProject(r.project);
      } catch { /* try again next tick */ }
    }, 10000);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [project, email]);

  const safeName = (n: string) => n.replace(/[^\w.-]+/g, '_').slice(-60);

  const handleFootage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError('');
    setFootageFile(f);
    setFootagePreview(URL.createObjectURL(f));
    setFootageUrl('');
    setUploading(true);
    try {
      setFootageUrl(await uploadToStorage(f, `vfx_footage/${email}/${Date.now()}_${safeName(f.name)}`));
    } catch (err: any) { setError(err.message || 'อัปโหลดไม่สำเร็จ'); } finally { setUploading(false); }
  };
  const handleRefs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).slice(0, 4);
    if (!files.length) return;
    setUploading(true);
    try {
      const urls: string[] = [];
      for (const f of files) urls.push(await uploadToStorage(f, `vfx_refs/${email}/${Date.now()}_${safeName(f.name)}`));
      setRefUrls((prev) => [...prev, ...urls].slice(0, 4));
    } catch (err: any) { setError(err.message || 'อัปโหลดภาพอ้างอิงไม่สำเร็จ'); } finally { setUploading(false); }
  };

  const createProject = async () => {
    if (!footageUrl) return;
    setBusy('กำลังวิเคราะห์ฟุตเทจและแบ่งช็อต...');
    setError('');
    try {
      const r = await api('/api/vfx/projects', { footage_url: footageUrl, reference_urls: refUrls, name, instruction, engine, grade });
      setProject(r.project);
      setPrompts({});
      await loadList();
      if (instruction.trim()) await plan(r.project);
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const plan = async (p: VfxProject | null = project) => {
    if (!p) return;
    setBusy('กำลังวางแผนเลเยอร์และคิดราคา...');
    setError('');
    try {
      const r = await api('/api/vfx/plan', { project_id: p.id, instruction: instruction || p.instruction, reference_urls: refUrls.length ? refUrls : p.reference_urls, engine, grade, prompts });
      setProject(r.project);
      setPrompts(Object.fromEntries(r.project.shots.map((s: VfxShot) => [s.id, s.layers.find((l) => l.type === 'background' || l.type === 'edit')?.params?.prompt || ''])));
      setConfirmed(false);
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const run = async () => {
    if (!project || !confirmed) return;
    setBusy('กำลังส่งงานทุกช็อต...');
    setError('');
    try {
      // Push any edited prompts first so the run uses them
      const edited = Object.entries(prompts).some(([id, p]) => p !== (project.shots.find((s) => s.id === id)?.layers.find((l) => l.type === 'background' || l.type === 'edit')?.params?.prompt || ''));
      let current = project;
      if (edited) current = (await api('/api/vfx/plan', { project_id: project.id, engine: project.engine, grade: project.grade, prompts })).project;
      const r = await api('/api/vfx/run', { project_id: current.id, confirm_credits: pendingCredits(current) });
      setProject(r.project);
      setConfirmed(false);
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const shotAction = async (shot: VfxShot, action: string, extra: any = {}) => {
    if (!project) return;
    setBusy(`${action}...`);
    setError('');
    try {
      const r = await api('/api/vfx/shot', { project_id: project.id, shot_id: shot.id, action, ...extra });
      setProject(r.project);
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const exportProject = async (allowPartial = false) => {
    if (!project) return;
    setBusy('กำลังรวมช็อตที่อนุมัติ...');
    setError('');
    try {
      const r = await api('/api/vfx/export', { project_id: project.id, allow_partial: allowPartial });
      setProject(r.project);
      await loadList();
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const pendingShots = (p: VfxProject) => p.shots.filter((s) => s.status !== 'processing' && s.status !== 'review' && s.status !== 'approved');
  const pendingCredits = (p: VfxProject) => pendingShots(p).reduce((sum, s) => sum + s.layers.filter((l) => l.enabled).reduce((a, l) => a + l.cost_credits, 0), 0) + (pendingShots(p).length ? 1 : 0);

  const step = !project ? 1 : project.shots.some((s) => !s.layers.length) || (pendingShots(project).length === project.shots.length && !project.shots.some((s) => s.status === 'processing')) ? 2 : project.status === 'exported' ? 4 : 3;

  // ────────────────────────────── render ──────────────────────────────
  return (
    <div className="space-y-6">
      {/* Stepper */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-thai">
        {['1 ฟุตเทจ + บรีฟ', '2 แผนและราคา', '3 ตรวจทีละช็อต', '4 ส่งออก'].map((t, i) => (
          <div key={t} className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-lg font-semibold ${step === i + 1 ? 'bg-[#1A1A1A] text-[#D4AF37]' : step > i + 1 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>{t}</span>
            {i < 3 && <ChevronRight className="w-3 h-3 text-gray-300" />}
          </div>
        ))}
        {project && (
          <button type="button" onClick={() => { setProject(null); setConfirmed(false); }} className="ml-auto text-gray-500 underline">โปรเจกต์ใหม่ / รายการ</button>
        )}
      </div>

      {error && <p className="text-xs text-red-600 font-thai flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</p>}
      {busy && <p className="text-xs text-[#D4AF37] font-thai flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {busy}</p>}

      {/* ── Step 1 ── */}
      {!project && (
        <>
          <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2"><Film className="w-4 h-4 text-[#D4AF37]" /> ฟุตเทจคนแสดงจริง (≤60 วิ)</h3>
            <input type="file" accept="video/mp4,video/quicktime" onChange={handleFootage} disabled={!!busy} className="w-full text-xs text-gray-500 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#1A1A1A] file:text-[#D4AF37] font-thai cursor-pointer" />
            {footagePreview && (
              <div className="flex flex-col sm:flex-row gap-4">
                <video src={footagePreview} controls className="w-full sm:w-64 rounded-xl bg-black border border-gray-200" />
                <div className="text-xs font-thai space-y-1 text-gray-600">
                  {uploading && <p className="flex items-center gap-1.5 text-[#D4AF37]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังอัปโหลดตรงเข้าคลัง...</p>}
                  {footageUrl && <p className="flex items-center gap-1.5 text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> อัปโหลดแล้ว</p>}
                  <p className="text-gray-400">ระบบจะแบ่งช็อตอัตโนมัติตามจุดตัดภาพ (และไม่เกิน 15 วิ/ช็อต)</p>
                </div>
              </div>
            )}
          </section>

          <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2"><ImageIcon className="w-4 h-4 text-[#D4AF37]" /> บรีฟฉากใหม่ + ภาพอ้างอิง (ทางเลือก ≤4)</h3>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อโปรเจกต์ เช่น โฆษณาห้องแล็บ v1" className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-thai focus:outline-none focus:ring-1 focus:ring-[#D4AF37]" />
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} placeholder="บรรยายฉากใหม่ที่ต้องการ เช่น ห้องแล็บวิทยาศาสตร์สมัยใหม่ แสงธรรมชาติจากหน้าต่างซ้าย — ระบบจะเขียน prompt ต่อช็อตให้ตรงมุมกล้อง" className="w-full px-4 py-3 border border-gray-200 rounded-xl text-sm font-thai focus:outline-none focus:ring-1 focus:ring-[#D4AF37]" />
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept="image/*" multiple onChange={handleRefs} disabled={!!busy} className="text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[11px] file:font-semibold file:bg-white file:border file:border-gray-300 font-thai cursor-pointer" />
              {refUrls.map((u) => <img key={u} src={u} alt="ref" className="w-14 h-14 object-cover rounded-lg border border-gray-200" />)}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ENGINES.map((e) => (
                <button key={e.id} type="button" onClick={() => setEngine(e.id)} className={`text-left p-4 rounded-2xl border-2 bg-white ${engine === e.id ? 'border-[#D4AF37] shadow-sm' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold font-thai flex items-center gap-1.5">{e.id === 'matte' ? <Scissors className="w-4 h-4 text-[#D4AF37]" /> : <Wand2 className="w-4 h-4 text-[#D4AF37]" />} {e.label}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1A1A1A] text-[#D4AF37] font-thai">{e.perSec} เครดิต/วิ</span>
                  </div>
                  <p className="text-[11px] text-gray-500 font-thai">{e.blurb}</p>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-thai">
              <span className="text-gray-600">ปรับสี:</span>
              {GRADES.map((g) => <button key={g.id} type="button" onClick={() => setGrade(g.id)} className={`px-3 py-1.5 rounded-lg border ${grade === g.id ? 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]' : 'bg-white text-gray-600 border-gray-200'}`}>{g.label}</button>)}
            </div>
            <button type="button" onClick={createProject} disabled={!footageUrl || uploading || !!busy} className="w-full py-3.5 bg-[#1A1A1A] hover:bg-black text-[#D4AF37] font-semibold rounded-xl shadow-md disabled:opacity-40 font-thai flex items-center justify-center gap-2">
              <Sparkles className="w-4 h-4" /> วิเคราะห์ฟุตเทจและวางแผน (ยังไม่หักเครดิต)
            </button>
          </section>

          {projects.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2"><FolderOpen className="w-4 h-4 text-[#D4AF37]" /> โปรเจกต์ของฉัน</h3>
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-3 bg-white border border-gray-150 rounded-xl px-4 py-2.5 text-xs font-thai">
                  <button type="button" onClick={() => openProject(p.id)} className="flex-1 text-left font-semibold text-[#1A1A1A] hover:underline">{p.name}</button>
                  <span className="text-gray-500">{p.shots} ช็อต · {p.footage_seconds.toFixed(1)} วิ</span>
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{statusLabel[p.status] || p.status}</span>
                  {p.export_url && <a href={p.export_url} target="_blank" rel="noreferrer" className="text-[#D4AF37] underline">ไฟล์</a>}
                  <button type="button" title="ลบโปรเจกต์" onClick={async () => { if (!confirm('ลบโปรเจกต์นี้?')) return; await fetch('/api/vfx/projects', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: email, id: p.id }) }); loadList(); }} className="text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {/* ── Steps 2–4: the project ── */}
      {project && (
        <>
          <section className="bg-[#FAF8F5] border border-gray-100 p-5 rounded-2xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[#1A1A1A] font-thai">{project.name} <span className="text-gray-400 font-normal">· {project.footage.seconds.toFixed(1)} วิ · {project.footage.width}×{project.footage.height} · {project.shots.length} ช็อต</span></h3>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#1A1A1A] text-[#D4AF37] font-thai">{statusLabel[project.status] || project.status}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-thai">
              <textarea value={instruction || project.instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} placeholder="บรีฟฉากใหม่" className="md:col-span-2 px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37]" />
              <div className="space-y-2">
                <div className="flex gap-1">{ENGINES.map((e) => <button key={e.id} type="button" onClick={() => setEngine(e.id)} className={`flex-1 px-2 py-1.5 rounded-lg border ${(engine) === e.id ? 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]' : 'bg-white border-gray-200 text-gray-600'}`}>{e.id === 'matte' ? 'ตัดคน+ฉาก' : 'O3 Edit'}</button>)}</div>
                <div className="flex gap-1">{GRADES.map((g) => <button key={g.id} type="button" onClick={() => setGrade(g.id)} className={`flex-1 px-1 py-1 rounded-lg border text-[10px] ${grade === g.id ? 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]' : 'bg-white border-gray-200 text-gray-600'}`}>{g.label}</button>)}</div>
                <button type="button" onClick={() => plan()} disabled={!!busy || project.shots.some((s) => s.status === 'processing')} className="w-full py-2 rounded-xl bg-white border border-[#D4AF37] text-[#1A1A1A] font-semibold disabled:opacity-40 flex items-center justify-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> วางแผน / คิดราคาใหม่</button>
              </div>
            </div>
          </section>

          {/* Shot list */}
          <div className="space-y-4">
            {project.shots.map((shot) => {
              const bgLayer = shot.layers.find((l) => l.type === 'background' || l.type === 'edit');
              const shotCredits = shot.layers.filter((l) => l.enabled).reduce((a, l) => a + l.cost_credits, 0);
              const editable = shot.status === 'draft' || shot.status === 'failed';
              return (
                <div key={shot.id} className={`rounded-2xl border p-4 space-y-3 bg-white ${shot.status === 'failed' ? 'border-red-300' : shot.status === 'approved' ? 'border-green-300' : 'border-gray-200'}`}>
                  <div className="flex flex-wrap items-center gap-3 text-xs font-thai">
                    <span className="px-2 py-0.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] font-bold">ช็อต {shot.order}</span>
                    <span className="text-gray-500">{shot.start.toFixed(1)}–{shot.end.toFixed(1)} วิ ({(shot.end - shot.start).toFixed(1)} วิ)</span>
                    {shot.analysis?.summary && <span className="text-gray-400 truncate max-w-md" title={shot.analysis.summary}>{shot.analysis.summary}</span>}
                    <span className={`ml-auto px-2 py-0.5 rounded-full ${shot.status === 'processing' ? 'bg-amber-100 text-amber-700' : shot.status === 'review' ? 'bg-blue-100 text-blue-700' : shot.status === 'approved' ? 'bg-green-100 text-green-700' : shot.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                      {shot.status === 'processing' && <Loader2 className="inline w-3 h-3 animate-spin mr-1" />}{statusLabel[shot.status]}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] text-gray-400 font-thai mb-1">ก่อน</p>
                      {shot.thumb_url && !shot.output_url ? <img src={shot.thumb_url} alt="" className="w-full rounded-xl border border-gray-200" /> : <video src={shot.clip_url} controls className="w-full rounded-xl bg-black border border-gray-200" />}
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 font-thai mb-1">หลัง</p>
                      {shot.output_url ? <video src={shot.output_url} controls className="w-full rounded-xl bg-black border border-[#D4AF37]" /> : (
                        <div className="w-full aspect-video rounded-xl border border-dashed border-gray-300 flex items-center justify-center text-[11px] text-gray-400 font-thai">{shot.status === 'processing' ? 'กำลังสร้าง...' : 'ยังไม่สร้าง'}</div>
                      )}
                    </div>
                  </div>

                  {/* layers */}
                  {shot.layers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 text-[10px] font-thai">
                      {shot.layers.map((l) => (
                        <span key={l.id} title={l.error || ''} className={`px-2 py-0.5 rounded-full border ${!l.enabled ? 'border-gray-200 text-gray-300 line-through' : l.status === 'done' ? 'border-green-300 text-green-700 bg-green-50' : l.status === 'processing' ? 'border-amber-300 text-amber-700 bg-amber-50' : l.status === 'failed' ? 'border-red-300 text-red-700 bg-red-50' : 'border-gray-200 text-gray-500'}`}>
                          {layerLabel[l.type]}{l.cost_credits ? ` ${l.cost_credits}cr` : ''}{l.version > 1 ? ` v${l.version}` : ''}
                        </span>
                      ))}
                      <span className="ml-auto text-gray-500">รวม {shotCredits} เครดิต</span>
                    </div>
                  )}
                  {shot.error && <p className="text-[11px] text-red-600 font-thai">{shot.error}</p>}

                  {/* prompt (plan stage) */}
                  {bgLayer && editable && (
                    <textarea value={prompts[shot.id] ?? bgLayer.params.prompt ?? ''} onChange={(e) => setPrompts((p) => ({ ...p, [shot.id]: e.target.value }))} rows={2} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-[#D4AF37]" placeholder="prompt ฉากหลังของช็อตนี้ (อังกฤษ)" />
                  )}

                  {/* review actions */}
                  {(shot.status === 'review' || shot.status === 'approved') && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-thai">
                        <button type="button" onClick={() => shotAction(shot, 'approve', { value: shot.status !== 'approved' })} disabled={!!busy} className={`px-3 py-1.5 rounded-lg font-semibold ${shot.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-[#1A1A1A] text-[#D4AF37]'}`}>
                          <CheckCircle2 className="inline w-3.5 h-3.5 mr-1" />{shot.status === 'approved' ? 'อนุมัติแล้ว (กดเพื่อยกเลิก)' : 'อนุมัติช็อตนี้'}
                        </button>
                        <span className="text-gray-500">ปรับสี:</span>
                        {GRADES.map((g) => <button key={g.id} type="button" disabled={!!busy} onClick={() => shotAction(shot, 'regrade', { preset: g.id })} className={`px-2 py-1 rounded-lg border ${shot.layers.find((l) => l.type === 'grade')?.params.preset === g.id ? 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]' : 'bg-white border-gray-200 text-gray-600'}`}>{g.label}</button>)}
                      </div>
                      {project.engine === 'matte' ? (
                        <div className="flex gap-2">
                          <input value={redoPrompt[shot.id] ?? bgLayer?.params.prompt ?? ''} onChange={(e) => setRedoPrompt((p) => ({ ...p, [shot.id]: e.target.value }))} className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs" placeholder="prompt ฉากหลังใหม่" />
                          <button type="button" disabled={!!busy} onClick={() => shotAction(shot, 'redo_background', { prompt: redoPrompt[shot.id] ?? bgLayer?.params.prompt })} className="px-3 py-1.5 rounded-lg bg-white border border-[#D4AF37] text-xs font-semibold font-thai whitespace-nowrap"><RefreshCw className="inline w-3 h-3 mr-1" />gen ใหม่เฉพาะฉากหลัง (3 cr, ไม่ตัดคนซ้ำ)</button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input value={redoPrompt[shot.id] ?? bgLayer?.params.prompt ?? ''} onChange={(e) => setRedoPrompt((p) => ({ ...p, [shot.id]: e.target.value }))} className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs" placeholder="prompt ใหม่" />
                          <button type="button" disabled={!!busy} onClick={() => shotAction(shot, 'rerun', { prompt: redoPrompt[shot.id] ?? bgLayer?.params.prompt })} className="px-3 py-1.5 rounded-lg bg-white border border-[#D4AF37] text-xs font-semibold font-thai whitespace-nowrap"><RefreshCw className="inline w-3 h-3 mr-1" />เรนเดอร์ช็อตใหม่ ({shotCredits} cr)</button>
                        </div>
                      )}
                    </div>
                  )}
                  {shot.status === 'failed' && shot.layers.length > 0 && (
                    <button type="button" disabled={!!busy} onClick={() => shotAction(shot, 'rerun', { prompt: prompts[shot.id] })} className="px-3 py-1.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-semibold font-thai">ลองใหม่ ({shotCredits} cr)</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Confirm + run */}
          {pendingShots(project).length > 0 && project.shots.every((s) => s.layers.length > 0) && (
            <section className="rounded-2xl border border-[#D4AF37]/40 bg-[#D4AF37]/5 p-5 space-y-3 font-thai">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-[#1A1A1A] flex items-center gap-2"><Sparkles className="w-4 h-4 text-[#D4AF37]" /> {pendingShots(project).length} ช็อตรอสร้าง</p>
                <p className="text-2xl font-display font-bold text-[#1A1A1A]">{pendingCredits(project)} <span className="text-[10px] text-gray-500 font-thai font-normal">เครดิต</span></p>
              </div>
              <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-[#D4AF37]" />
                ยืนยันหัก {pendingCredits(project)} เครดิตตามแผนนี้ — งานเดินต่อบนเซิร์ฟเวอร์แม้ปิดแท็บ
              </label>
              <button type="button" onClick={run} disabled={!confirmed || !!busy} className="w-full py-3 bg-[#1A1A1A] hover:bg-black text-[#D4AF37] font-semibold rounded-xl disabled:opacity-40 flex items-center justify-center gap-2"><Layers className="w-4 h-4" /> ยืนยันและสร้างทุกช็อต</button>
            </section>
          )}

          {/* Export */}
          {project.shots.some((s) => s.status === 'approved') && (
            <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 font-thai">
              <p className="text-sm font-semibold text-[#1A1A1A] flex items-center gap-2"><Download className="w-4 h-4 text-[#D4AF37]" /> ส่งออก ({project.shots.filter((s) => s.status === 'approved').length}/{project.shots.length} ช็อตอนุมัติแล้ว)</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!!busy || project.shots.some((s) => s.status !== 'approved')} onClick={() => exportProject(false)} className="px-4 py-2 bg-[#1A1A1A] text-[#D4AF37] rounded-xl text-xs font-semibold disabled:opacity-40">รวมทุกช็อตเป็นคลิปเดียว</button>
                <button type="button" disabled={!!busy} onClick={() => exportProject(true)} className="px-4 py-2 bg-white border border-gray-300 rounded-xl text-xs font-semibold">ส่งออกเฉพาะที่อนุมัติ</button>
              </div>
              {project.export_url && (
                <div className="space-y-2">
                  <video src={project.export_url} controls className="w-full rounded-xl bg-black border border-[#D4AF37]" />
                  <a href={project.export_url} download className="text-xs underline text-[#1A1A1A]">ดาวน์โหลด MP4</a>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

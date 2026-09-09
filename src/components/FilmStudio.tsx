'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { uploadToStorage } from '@/lib/supabase-db';
import type { Film, MasterAsset, FilmScene, StyleBible, ContinuityFields } from '@/lib/film/types';
import { EMPTY_CONTINUITY } from '@/lib/film/types';
import { Clapperboard, Loader2, Lock, Unlock, Palette, MapPin, User, Plus, RefreshCw, CheckCircle2, AlertCircle, Trash2, Film as FilmIcon, Anchor, Shirt, Eye } from 'lucide-react';

/** scenes in film order (act order, then scene order) — mirrors lib/film/continuity */
function orderedScenes(film: Film): FilmScene[] {
  const actOrder = new Map((film.acts || []).map((a) => [a.id, a.order] as const));
  return [...film.scenes].sort((a, b) => (actOrder.get(a.act_id || '') ?? 0) - (actOrder.get(b.act_id || '') ?? 0) || a.order - b.order);
}
/** effective continuity of a subject in a scene: own state or the latest earlier scene's */
function cellState(film: Film, sceneId: string, subjectId: string): { state: ContinuityFields; own: boolean; source: string; from?: FilmScene; rec?: Film['continuity'][number] } {
  const scenes = orderedScenes(film);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  for (let i = idx; i >= 0; i--) {
    const rec = (film.continuity || []).find((c) => c.scene_id === scenes[i].id && c.subject_master_id === subjectId);
    if (rec) return { state: { ...EMPTY_CONTINUITY, ...rec.state }, own: i === idx, source: rec.source, from: i === idx ? undefined : scenes[i], rec: i === idx ? rec : undefined };
  }
  return { state: { ...EMPTY_CONTINUITY }, own: false, source: 'none' };
}
function stateSummary(s: ContinuityFields): string {
  const d: string[] = [];
  if (s.wardrobe) d.push(`👕 ${s.wardrobe}`); if (s.hair) d.push(`💇 ${s.hair}`); if (s.injuries) d.push(`🩹 ${s.injuries}`);
  if (s.props_held?.length) d.push(`✋ ${s.props_held.join(', ')}`); if (s.dirt_level && s.dirt_level !== 'clean') d.push(s.dirt_level === 'heavy' ? '🟤 สกปรกมาก' : '🟫 สกปรกเล็กน้อย');
  if (s.notes) d.push(`📝 ${s.notes}`);
  return d.join(' · ');
}

/**
 * Film Mode F1 — Bible Studio + masters + scenes with anchor-matched grading.
 * Consistency lives in locked assets: the Bible is locked before shooting, scenes name a
 * locked location master, shots are generated against that plate with a neutral grade,
 * and the deterministic grade (LUT + anchor match) reports ΔE per shot against the Bible's
 * threshold. Changing the LUT re-grades the scene without any generative job.
 */

interface ConsentRecord { id: string; face_url: string; person_name: string }

export default function FilmStudio() {
  const { user } = useAuth();
  const email = user?.email || '';
  const [films, setFilms] = useState<any[]>([]);
  const [film, setFilm] = useState<Film | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [bibleDraft, setBibleDraft] = useState<StyleBible | null>(null);
  const [masterForm, setMasterForm] = useState<{ kind: MasterAsset['kind']; name: string; urls: string[]; consent_id: string }>({ kind: 'location', name: '', urls: [], consent_id: '' });
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [sceneForm, setSceneForm] = useState<{ name: string; master: string; time: string; weather: string; act: string }>({ name: '', master: '', time: 'กลางวัน', weather: 'แจ่มใส', act: '' });
  const [showStyle, setShowStyle] = useState<string>(''); // shot id whose effective style is open
  const [shotFootage, setShotFootage] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [gradeReport, setGradeReport] = useState<Record<string, any>>({});
  const [contReport, setContReport] = useState<Record<string, any>>({});
  const [contEdit, setContEdit] = useState<{ scene_id: string; subject_id: string; draft: ContinuityFields; props: string } | null>(null);
  const [contHistory, setContHistory] = useState<string>(''); // "sceneId:subjectId" whose history is open
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = async (path: string, body: any) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: email, user_id: user?.id || '', ...body }) });
    const j = await r.json();
    if (!j.success) { const e: any = new Error(j.error || 'คำขอไม่สำเร็จ'); e.payload = j; throw e; }
    return j;
  };
  const loadList = useCallback(async () => {
    if (!email) return;
    const j = await fetch(`/api/film/films?email=${encodeURIComponent(email)}`).then((r) => r.json()).catch(() => null);
    if (j?.success) setFilms(j.films);
    const c = await fetch(`/api/vfx/consent?email=${encodeURIComponent(email)}`).then((r) => r.json()).catch(() => null);
    if (c?.success) setConsents(c.consents);
  }, [email]);
  useEffect(() => { loadList(); }, [loadList]);

  const open = async (id: string) => {
    const j = await fetch(`/api/film/films?email=${encodeURIComponent(email)}&id=${id}`).then((r) => r.json());
    if (j.success) { setFilm(j.film); setBibleDraft(j.film.bible); } else setError(j.error);
  };
  const act = async (path: string, body: any, label: string) => {
    setBusy(label); setError('');
    try { const j = await api(path, { film_id: film?.id, ...body }); const fresh = await fetch(`/api/film/films?email=${encodeURIComponent(email)}&id=${film?.id}`).then((r) => r.json()); const doc = fresh.success ? fresh.film : j.film; setFilm(doc); setBibleDraft(doc.bible); return { ...j, film: doc }; }
    catch (err: any) { setError(err.message); return null; }
    finally { setBusy(''); }
  };

  // shots in flight: sync with the VFX studio every 12 s
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!film || !film.scenes.some((s) => s.shots.some((x) => x.status === 'processing'))) return;
    pollRef.current = setTimeout(async () => {
      // nudge each in-flight VFX project the way the studio does, then sync
      for (const sc of film.scenes) for (const sh of sc.shots) {
        if (sh.status !== 'processing') continue;
        const p = await fetch(`/api/vfx/projects?email=${encodeURIComponent(email)}&id=${sh.vfx_project_id}`).then((r) => r.json()).catch(() => null);
        for (const s of p?.project?.shots || []) for (const l of s.layers) if (l.status === 'processing' && l.job_request_id) fetch('/api/video-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: l.job_request_id, videoPath: `vfx_shots/${email}/${sh.vfx_project_id}/${s.id}_${l.type}.mp4`, modelType: 'vfx', storageProvider: 'supabase' }) }).catch(() => {});
      }
      try { await api('/api/film/scenes', { film_id: film.id, action: 'sync' }); const fresh = await fetch(`/api/film/films?email=${encodeURIComponent(email)}&id=${film.id}`).then((r) => r.json()); if (fresh.success) setFilm(fresh.film); } catch { /* next tick */ }
    }, 12000);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [film, email]);

  const safe = (n: string) => n.replace(/[^\w.-]+/g, '_').slice(-60);
  const uploadMany = async (files: File[], prefix: string) => {
    setUploading(true);
    try { const out: string[] = []; for (const f of files) out.push(await uploadToStorage(f, `${prefix}/${email}/${Date.now()}_${safe(f.name)}`, { private: true })); return out; }
    finally { setUploading(false); }
  };

  const addShot = async (scene: FilmScene) => {
    const url = shotFootage[scene.id];
    if (!url || !film) return;
    setBusy('กำลังวิเคราะห์ฟุตเทจและคิดราคา...'); setError('');
    try {
      let j: any;
      try { j = await api('/api/film/scenes', { film_id: film.id, action: 'add_shot', scene_id: scene.id, footage_url: url, confirm_credits: -1 }); }
      catch (e: any) {
        if (e.payload?.credits == null) throw e;
        if (!confirm(`ช็อตนี้ ${e.payload.credits} เครดิต (ตัดคน + วางบนฉาก master "${film.masters.find((m) => m.id === scene.location_master_id)?.name}") ยืนยัน?`)) return;
        j = await api('/api/film/scenes', { film_id: film.id, action: 'add_shot', scene_id: scene.id, footage_url: url, confirm_credits: e.payload.credits });
      }
      const fresh = await fetch(`/api/film/films?email=${encodeURIComponent(email)}&id=${film.id}`).then((r) => r.json()); setFilm(fresh.success ? fresh.film : j.film); setShotFootage((p) => ({ ...p, [scene.id]: '' }));
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  const gradeScene = async (scene: FilmScene) => {
    const j = await act('/api/film/scenes', { action: 'grade_scene', scene_id: scene.id }, `กำลัง grade ฉาก ${scene.name} (LUT + anchor match)...`);
    if (j) setGradeReport((p) => ({ ...p, [scene.id]: { mean: j.mean_delta_e, threshold: j.threshold, results: j.results } }));
  };

  const bibleLocked = !!film?.bible.locked_at;

  return (
    <div className="space-y-6 font-thai">
      {error && <p className="text-xs text-red-600 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</p>}
      {busy && <p className="text-xs text-[#D4AF37] flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {busy}</p>}

      {!film && (
        <>
          <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2"><Clapperboard className="w-4 h-4 text-[#D4AF37]" /> หนังเรื่องใหม่</h3>
            <div className="flex gap-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ชื่อเรื่อง" className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-[#D4AF37]" />
              <button type="button" disabled={!title.trim() || !!busy} onClick={async () => { setBusy('กำลังสร้าง...'); try { const j = await api('/api/film/films', { action: 'create', title }); setFilm(j.film); setBibleDraft(j.film.bible); setTitle(''); loadList(); } catch (e: any) { setError(e.message); } finally { setBusy(''); } }} className="px-5 py-2.5 rounded-xl bg-[#1A1A1A] text-[#D4AF37] font-semibold disabled:opacity-40">สร้าง</button>
            </div>
            <p className="text-[11px] text-gray-400">ลำดับงาน: ตั้ง Style Bible → ล็อก → สร้าง master (สถานที่/ตัวละคร) → ล็อก → ฉากอ้าง master → ช็อตทุกช็อตถ่ายบนฉากเดียวกัน → อนุมัติ anchor frame → grade ทั้งฉากให้ ΔE &lt; {6}</p>
          </section>
          {films.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">หนังของฉัน</h3>
              {films.map((f) => (
                <div key={f.id} className="flex items-center gap-3 bg-white border border-gray-150 rounded-xl px-4 py-2.5 text-xs">
                  <button type="button" onClick={() => open(f.id)} className="flex-1 text-left font-semibold text-[#1A1A1A] hover:underline">{f.title}</button>
                  <span className="text-gray-500">Bible v{f.bible_version} · {f.scenes} ฉาก · {f.shots} ช็อต</span>
                  <button type="button" onClick={async () => { if (!confirm('ลบหนังเรื่องนี้?')) return; await fetch('/api/film/films', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: email, id: f.id }) }); loadList(); }} className="text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {film && bibleDraft && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-[#1A1A1A] flex items-center gap-2"><Clapperboard className="w-5 h-5 text-[#D4AF37]" /> {film.title}</h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Bible v{film.bible.version} {bibleLocked ? '🔒' : '(ยังไม่ล็อก)'}</span>
            <button type="button" onClick={() => setFilm(null)} className="ml-auto text-xs text-gray-500 underline">รายการหนัง</button>
          </div>

          {/* ── Bible Studio ── */}
          <section className="bg-[#FAF8F5] border border-gray-100 p-5 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2"><Palette className="w-4 h-4 text-[#D4AF37]" /> Style Bible</h3>
              {bibleLocked ? (
                <button type="button" disabled={!!busy} onClick={() => { if (confirm('เวอร์ชันใหม่ของ Bible: ค่าปัจจุบันจะถูกเก็บในประวัติ ช็อตเดิมยังอ้างเวอร์ชันเก่าจนกว่าจะ grade ใหม่')) act('/api/film/films', { action: 'bump_bible', bible: bibleDraft }, 'กำลังสร้าง Bible เวอร์ชันใหม่...'); }} className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 flex items-center gap-1"><Unlock className="w-3 h-3" /> bump เวอร์ชัน (แก้ไข)</button>
              ) : (
                <div className="flex gap-2">
                  <button type="button" disabled={!!busy} onClick={() => act('/api/film/films', { action: 'update_bible', bible: bibleDraft }, 'กำลังบันทึก Bible...')} className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300">บันทึก</button>
                  <button type="button" disabled={!!busy} onClick={async () => { await act('/api/film/films', { action: 'update_bible', bible: bibleDraft }, 'บันทึก...'); act('/api/film/films', { action: 'lock_bible' }, 'กำลังล็อก Bible...'); }} className="text-xs px-3 py-1.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] flex items-center gap-1"><Lock className="w-3 h-3" /> ล็อก Bible</button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1.5">
                <label className="text-gray-500">พาเลตต์สี</label>
                <div className="flex flex-wrap gap-1.5 items-center">
                  {bibleDraft.palette.map((c, i) => (
                    <span key={i} className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg pl-1 pr-1.5 py-0.5">
                      <input type="color" value={c} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, palette: bibleDraft.palette.map((x, j) => (j === i ? e.target.value : x)) })} className="w-6 h-6 rounded border-0 bg-transparent cursor-pointer" /> {c}
                      {!bibleLocked && <button type="button" onClick={() => setBibleDraft({ ...bibleDraft, palette: bibleDraft.palette.filter((_, j) => j !== i) })} className="text-gray-400">×</button>}
                    </span>
                  ))}
                  {!bibleLocked && bibleDraft.palette.length < 8 && <button type="button" onClick={() => setBibleDraft({ ...bibleDraft, palette: [...bibleDraft.palette, '#888888'] })} className="px-2 py-1 rounded-lg border border-dashed border-gray-300">+ สี</button>}
                </div>
                <label className="text-gray-500 block pt-1">LUT (.cube) {bibleDraft.lut_name && <span className="text-[#1A1A1A] font-semibold">· {bibleDraft.lut_name}</span>}</label>
                <input type="file" accept=".cube" disabled={bibleLocked || uploading} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const [url] = await uploadMany([f], 'films_lut'); setBibleDraft({ ...bibleDraft, lut_url: url, lut_name: f.name }); }} className="text-[11px]" />
                {bibleDraft.lut_url && !bibleLocked && <button type="button" onClick={() => setBibleDraft({ ...bibleDraft, lut_url: undefined, lut_name: undefined })} className="text-[11px] text-red-500 underline">เอา LUT ออก</button>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(['key', 'fill', 'ratio', 'tone'] as const).map((k) => (
                  <label key={k} className="text-gray-500">{{ key: 'แสงหลัก', fill: 'แสงเสริม', ratio: 'อัตราส่วน', tone: 'โทน' }[k]}
                    <input value={bibleDraft.lighting_rules[k]} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, lighting_rules: { ...bibleDraft.lighting_rules, [k]: e.target.value } })} className="w-full mt-0.5 px-2 py-1 border border-gray-200 rounded-lg bg-white" />
                  </label>
                ))}
                <label className="text-gray-500">เลนส์
                  <input value={bibleDraft.lens.focal} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, lens: { ...bibleDraft.lens, focal: e.target.value } })} className="w-full mt-0.5 px-2 py-1 border border-gray-200 rounded-lg bg-white" />
                </label>
                <label className="text-gray-500">เกรน
                  <select value={bibleDraft.lens.grain} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, lens: { ...bibleDraft.lens, grain: e.target.value as any } })} className="w-full mt-0.5 px-2 py-1 border border-gray-200 rounded-lg bg-white"><option value="none">ไม่มี</option><option value="fine">ละเอียด</option><option value="medium">ปานกลาง</option><option value="heavy">หนัก</option></select>
                </label>
                <label className="text-gray-500">สัดส่วน
                  <select value={bibleDraft.aspect} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, aspect: e.target.value as any })} className="w-full mt-0.5 px-2 py-1 border border-gray-200 rounded-lg bg-white"><option>16:9</option><option>9:16</option><option>1:1</option><option>2.39:1</option></select>
                </label>
                <label className="text-gray-500">เกณฑ์ ΔE
                  <input type="number" min={1} max={20} value={bibleDraft.delta_e_threshold} disabled={bibleLocked} onChange={(e) => setBibleDraft({ ...bibleDraft, delta_e_threshold: Number(e.target.value) || 6 })} className="w-full mt-0.5 px-2 py-1 border border-gray-200 rounded-lg bg-white" />
                </label>
              </div>
            </div>
          </section>

          {/* ── Masters ── */}
          <section className="bg-[#FAF8F5] border border-gray-100 p-5 rounded-2xl space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2"><MapPin className="w-4 h-4 text-[#D4AF37]" /> Master assets (สถานที่ / ตัวละคร / พร็อพ)</h3>
            <div className="flex flex-wrap gap-2">
              {film.masters.map((m) => (
                <div key={m.id} className={`rounded-xl border p-2 bg-white text-[11px] w-44 ${m.locked ? 'border-[#D4AF37]' : 'border-gray-200'}`}>
                  <div className="flex gap-1 mb-1">{m.sheet_urls.slice(0, 3).map((u) => <img key={u} src={u} alt="" className="w-12 h-12 object-cover rounded-md" />)}</div>
                  <p className="font-semibold text-[#1A1A1A] flex items-center gap-1">{m.kind === 'character' ? <User className="w-3 h-3" /> : <MapPin className="w-3 h-3" />} {m.name} <span className="text-gray-400">v{m.version}</span></p>
                  <div className="flex items-center gap-2 mt-1">
                    {m.locked ? <span className="text-[#D4AF37] flex items-center gap-1"><Lock className="w-3 h-3" /> ล็อกแล้ว · ใช้ใน {m.used_by.length} ช็อต</span> : <button type="button" disabled={!!busy} onClick={() => act('/api/film/films', { action: 'lock_master', master_id: m.id }, 'กำลังล็อก...')} className="px-2 py-0.5 rounded-md bg-[#1A1A1A] text-[#D4AF37]">ล็อก</button>}
                    {m.locked && <button type="button" disabled={!!busy || uploading} onClick={async () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.onchange = async () => { const files = Array.from(inp.files || []); if (!files.length) return; const urls = await uploadMany(files, 'films_masters'); act('/api/film/films', { action: 'bump_master', master_id: m.id, sheet_urls: urls }, 'กำลังสร้างเวอร์ชันใหม่...'); }; inp.click(); }} className="text-gray-500 underline">bump v{m.version + 1}</button>}
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-dashed border-gray-300 p-3 space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <select value={masterForm.kind} onChange={(e) => setMasterForm({ ...masterForm, kind: e.target.value as any })} className="px-2 py-1.5 border border-gray-200 rounded-lg bg-white"><option value="location">สถานที่ (plate)</option><option value="character">ตัวละคร (ต้องมี consent)</option><option value="prop">พร็อพ</option></select>
                <input value={masterForm.name} onChange={(e) => setMasterForm({ ...masterForm, name: e.target.value })} placeholder="ชื่อ master" className="px-3 py-1.5 border border-gray-200 rounded-lg" />
                <input type="file" accept="image/*" multiple disabled={uploading} onChange={async (e) => { const files = Array.from(e.target.files || []).slice(0, 6); if (!files.length) return; setMasterForm({ ...masterForm, urls: await uploadMany(files, 'films_masters') }); }} className="text-[11px]" />
                {masterForm.kind === 'character' && (
                  <select value={masterForm.consent_id} onChange={(e) => { const c = consents.find((x) => x.id === e.target.value); setMasterForm({ ...masterForm, consent_id: e.target.value, urls: c ? [c.face_url] : masterForm.urls, name: masterForm.name || c?.person_name || '' }); }} className="px-2 py-1.5 border border-gray-200 rounded-lg bg-white">
                    <option value="">เลือกบันทึกความยินยอม…</option>{consents.map((c) => <option key={c.id} value={c.id}>{c.person_name}</option>)}
                  </select>
                )}
                {masterForm.urls.map((u) => <img key={u} src={u} alt="" className="w-9 h-9 rounded-md object-cover" />)}
                <button type="button" disabled={!!busy || !masterForm.name || !masterForm.urls.length || (masterForm.kind === 'character' && !masterForm.consent_id)} onClick={async () => { const j = await act('/api/film/films', { action: 'add_master', ...masterForm, sheet_urls: masterForm.urls }, 'กำลังเพิ่ม master...'); if (j) setMasterForm({ kind: 'location', name: '', urls: [], consent_id: '' }); }} className="px-3 py-1.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] font-semibold disabled:opacity-40 flex items-center gap-1"><Plus className="w-3 h-3" /> เพิ่ม master</button>
              </div>
              <p className="text-[10px] text-gray-400">master ที่ล็อกแล้วแก้ทับไม่ได้ — bump เป็นเวอร์ชันใหม่ ช็อตที่ใช้เวอร์ชันเก่าไม่ถูกแตะ · ภาพแรกของสถานที่คือ plate ที่ทุกช็อตในฉากใช้ร่วมกัน</p>
            </div>
          </section>

          {/* ── Continuity Board (F4): subject × scene, editable, with history + VLM proposals ── */}
          {film.masters.some((m) => m.kind === 'character' || m.kind === 'prop') && film.scenes.length > 0 && (
            <section className="bg-[#FAF8F5] border border-gray-100 p-5 rounded-2xl space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2"><Shirt className="w-4 h-4 text-[#D4AF37]" /> Continuity Board</h3>
              <p className="text-[10px] text-gray-400">สถานะของตัวละคร/พร็อพต่อฉาก (เสื้อผ้า ทรงผม บาดแผล พร็อพที่ถือ ความสกปรก) — ฉากถัดไปสืบทอดค่าล่าสุดจนกว่าจะตั้งใหม่ · resolver แนบ state นี้ให้ทุกช็อตที่สร้าง และ VLM ใช้ตรวจช็อตที่เสร็จแล้ว · หลังอนุมัติช็อต ระบบเสนอ state ที่เห็นในเฟรมสุดท้าย คุณยืนยันก่อนบันทึก</p>
              {(film.continuity_proposals || []).length > 0 && (
                <div className="space-y-1.5">
                  {film.continuity_proposals.map((p) => {
                    const sc = film.scenes.find((s) => s.id === p.scene_id); const subj = film.masters.find((m) => m.id === p.subject_master_id); const sh = sc?.shots.find((s) => s.id === p.from_shot_id);
                    return (
                      <div key={p.id} className="rounded-xl border border-[#D4AF37] bg-white px-3 py-2 text-[11px] flex flex-wrap items-center gap-2">
                        <Eye className="w-3.5 h-3.5 text-[#D4AF37]" />
                        <span className="font-semibold">{subj?.name}</span> <span className="text-gray-500">ฉาก {sc?.order} {sc?.name} · จากช็อต {sh?.order} ที่อนุมัติ</span>
                        <span className="text-gray-700">{p.diff.join(' · ')}</span>
                        <span className="ml-auto flex gap-1">
                          <button type="button" disabled={!!busy} onClick={() => act('/api/film/films', { action: 'confirm_proposal', proposal_id: p.id }, 'บันทึก state...')} className="px-2 py-0.5 rounded-md bg-[#1A1A1A] text-[#D4AF37]">ยืนยัน</button>
                          <button type="button" disabled={!!busy} onClick={() => act('/api/film/films', { action: 'reject_proposal', proposal_id: p.id }, 'ปฏิเสธ...')} className="px-2 py-0.5 rounded-md border border-gray-300 bg-white">ไม่ใช่</button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="text-[11px] border-separate border-spacing-0 min-w-full">
                  <thead>
                    <tr>
                      <th className="text-left px-2 py-1 text-gray-500 font-medium sticky left-0 bg-[#FAF8F5]">subject</th>
                      {orderedScenes(film).map((sc) => <th key={sc.id} className="text-left px-2 py-1 text-gray-500 font-medium min-w-[180px]">ฉาก {sc.order} · {sc.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {film.masters.filter((m) => m.kind === 'character' || m.kind === 'prop').map((subj) => (
                      <tr key={subj.id} className="align-top">
                        <td className="px-2 py-1.5 sticky left-0 bg-[#FAF8F5] border-t border-gray-100">
                          <span className="flex items-center gap-1 font-semibold text-[#1A1A1A]">{subj.sheet_urls[0] && <img src={subj.sheet_urls[0]} alt="" className="w-6 h-6 rounded object-cover" />}{subj.name}</span>
                          <span className="text-gray-400">{subj.kind === 'character' ? 'ตัวละคร' : 'พร็อพ'}</span>
                        </td>
                        {orderedScenes(film).map((sc) => {
                          const inScene = !Array.isArray(sc.subject_master_ids) || sc.subject_master_ids.includes(subj.id);
                          const cell = cellState(film, sc.id, subj.id);
                          const key = `${sc.id}:${subj.id}`;
                          const editing = contEdit && contEdit.scene_id === sc.id && contEdit.subject_id === subj.id;
                          const allSubjects = film.masters.filter((m) => m.kind === 'character' || m.kind === 'prop').map((m) => m.id);
                          const toggleIn = () => { const cur = Array.isArray(sc.subject_master_ids) ? sc.subject_master_ids : allSubjects; const next = inScene ? cur.filter((id) => id !== subj.id) : [...cur, subj.id]; act('/api/film/scenes', { action: 'set_subjects', scene_id: sc.id, subject_master_ids: next }, 'บันทึก subject ของฉาก...'); };
                          return (
                            <td key={sc.id} className={`px-2 py-1.5 border-t border-l border-gray-100 ${inScene ? '' : 'bg-gray-50 opacity-60'}`}>
                              {!inScene ? (
                                <button type="button" onClick={toggleIn} className="text-gray-400 underline">ไม่อยู่ในฉากนี้ (กดเพื่อเพิ่ม)</button>
                              ) : editing ? (
                                <div className="space-y-1 bg-white border border-[#D4AF37] rounded-lg p-2 w-56">
                                  {([['wardrobe', 'เสื้อผ้า'], ['hair', 'ทรงผม'], ['injuries', 'บาดแผล/ร่องรอย']] as const).map(([k, label]) => (
                                    <input key={k} value={(contEdit!.draft as any)[k]} onChange={(e) => setContEdit({ ...contEdit!, draft: { ...contEdit!.draft, [k]: e.target.value } })} placeholder={label} className="w-full px-2 py-1 border border-gray-200 rounded" />
                                  ))}
                                  <input value={contEdit!.props} onChange={(e) => setContEdit({ ...contEdit!, props: e.target.value })} placeholder="พร็อพที่ถือ (คั่นด้วย ,)" className="w-full px-2 py-1 border border-gray-200 rounded" />
                                  <select value={contEdit!.draft.dirt_level} onChange={(e) => setContEdit({ ...contEdit!, draft: { ...contEdit!.draft, dirt_level: e.target.value as any } })} className="w-full px-2 py-1 border border-gray-200 rounded bg-white"><option value="clean">สะอาด</option><option value="light">สกปรกเล็กน้อย</option><option value="heavy">สกปรกมาก</option></select>
                                  <input value={contEdit!.draft.notes || ''} onChange={(e) => setContEdit({ ...contEdit!, draft: { ...contEdit!.draft, notes: e.target.value } })} placeholder="หมายเหตุ" className="w-full px-2 py-1 border border-gray-200 rounded" />
                                  <div className="flex gap-1">
                                    <button type="button" disabled={!!busy} onClick={async () => { const j = await act('/api/film/films', { action: 'set_continuity', scene_id: sc.id, subject_master_id: subj.id, state: { ...contEdit!.draft, props_held: contEdit!.props.split(',').map((s) => s.trim()).filter(Boolean) } }, 'บันทึก continuity...'); if (j) setContEdit(null); }} className="px-2 py-0.5 rounded bg-[#1A1A1A] text-[#D4AF37]">บันทึก</button>
                                    <button type="button" onClick={() => setContEdit(null)} className="px-2 py-0.5 rounded border border-gray-300 bg-white">ยกเลิก</button>
                                    {cell.own && <button type="button" disabled={!!busy} onClick={async () => { const j = await act('/api/film/films', { action: 'set_continuity', scene_id: sc.id, subject_master_id: subj.id, clear: true }, 'ล้าง state ของฉากนี้...'); if (j) setContEdit(null); }} className="ml-auto text-red-500 underline">ล้าง (สืบทอดจากฉากก่อน)</button>}
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-0.5">
                                  {cell.source === 'none' ? <span className="text-gray-400 italic">ยังไม่กำหนด</span> : <span className={cell.own ? 'text-[#1A1A1A]' : 'text-gray-500 italic'}>{stateSummary(cell.state) || <span className="text-gray-400">ว่าง</span>}</span>}
                                  <div className="flex flex-wrap gap-x-2 text-[10px] text-gray-400">
                                    {cell.own ? <span>{cell.source === 'auto' ? '🤖 จาก VLM' : '✍️ ตั้งเอง'}</span> : cell.from ? <span>สืบทอดจากฉาก {cell.from.order}</span> : null}
                                    <button type="button" onClick={() => setContEdit({ scene_id: sc.id, subject_id: subj.id, draft: { ...cell.state }, props: (cell.state.props_held || []).join(', ') })} className="underline">{cell.own ? 'แก้' : 'ตั้งสำหรับฉากนี้'}</button>
                                    {cell.rec && cell.rec.history.length > 0 && <button type="button" onClick={() => setContHistory(contHistory === key ? '' : key)} className="underline">ประวัติ {cell.rec.history.length}</button>}
                                    <button type="button" onClick={toggleIn} className="underline">เอาออกจากฉาก</button>
                                  </div>
                                  {contHistory === key && cell.rec && (
                                    <ul className="text-[10px] text-gray-500 border-l-2 border-gray-200 pl-2 space-y-0.5">
                                      {cell.rec.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('th-TH')} · {h.source === 'auto' ? 'VLM' : 'ตั้งเอง'} · {stateSummary(h.state) || 'ว่าง'}</li>)}
                                    </ul>
                                  )}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Scenes ── */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 bg-[#FAF8F5] border border-gray-100 p-4 rounded-2xl text-xs">
              <FilmIcon className="w-4 h-4 text-[#D4AF37]" />
              <select value={sceneForm.act} onChange={(e) => setSceneForm({ ...sceneForm, act: e.target.value })} className="px-2 py-1.5 border border-gray-200 rounded-lg bg-white">
                <option value="">องก์แรก</option>{[...(film.acts || [])].sort((a, b) => a.order - b.order).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input value={sceneForm.name} onChange={(e) => setSceneForm({ ...sceneForm, name: e.target.value })} placeholder="ชื่อฉาก" className="px-3 py-1.5 border border-gray-200 rounded-lg" />
              <select value={sceneForm.master} onChange={(e) => setSceneForm({ ...sceneForm, master: e.target.value })} className="px-2 py-1.5 border border-gray-200 rounded-lg bg-white">
                <option value="">สถานที่ (master ที่ล็อกแล้ว)…</option>{film.masters.filter((m) => m.kind === 'location' && m.locked).map((m) => <option key={m.id} value={m.id}>{m.name} v{m.version}</option>)}
              </select>
              <input value={sceneForm.time} onChange={(e) => setSceneForm({ ...sceneForm, time: e.target.value })} placeholder="ช่วงเวลา" className="w-24 px-2 py-1.5 border border-gray-200 rounded-lg" />
              <input value={sceneForm.weather} onChange={(e) => setSceneForm({ ...sceneForm, weather: e.target.value })} placeholder="สภาพอากาศ" className="w-24 px-2 py-1.5 border border-gray-200 rounded-lg" />
              <button type="button" disabled={!!busy || !sceneForm.master} onClick={async () => { const j = await act('/api/film/scenes', { action: 'add_scene', name: sceneForm.name, location_master_id: sceneForm.master, time_of_day: sceneForm.time, weather: sceneForm.weather, act_id: sceneForm.act || undefined }, 'กำลังเพิ่มฉาก...'); if (j) setSceneForm({ ...sceneForm, name: '' }); }} className="px-3 py-1.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] font-semibold disabled:opacity-40 flex items-center gap-1"><Plus className="w-3 h-3" /> เพิ่มฉาก</button>
              <button type="button" disabled={!!busy} onClick={() => { const name = prompt('ชื่อองก์ใหม่', `องก์ ${(film.acts?.length || 0) + 1}`); if (name) act('/api/film/films', { action: 'add_act', name }, 'กำลังเพิ่มองก์...'); }} className="px-3 py-1.5 rounded-lg bg-white border border-gray-300 flex items-center gap-1"><Plus className="w-3 h-3" /> เพิ่มองก์</button>
            </div>

            {/* Structure (F2): film → act → scene → shot; move buttons reorder, overrides per layer */}
            {[...(film.acts || [])].sort((a, b) => a.order - b.order).map((actItem, ai, actsSorted) => (
            <div key={actItem.id} className="rounded-2xl border border-[#D4AF37]/30 bg-[#FAF8F5] p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-lg bg-[#D4AF37] text-[#1A1A1A] font-bold">องก์ {actItem.order}</span>
                <input defaultValue={actItem.name} onBlur={(e) => e.target.value !== actItem.name && act('/api/film/films', { action: 'update_act', act_id: actItem.id, name: e.target.value }, 'บันทึกชื่อองก์...')} className="px-2 py-1 border border-gray-200 rounded-lg bg-white font-semibold" />
                <label className="flex items-center gap-1 text-gray-500">exposure องก์ <input type="number" step={0.25} min={-2} max={2} value={actItem.style_override?.exposure_stops || 0} onChange={(e) => act('/api/film/films', { action: 'update_act', act_id: actItem.id, style_override: { exposure_stops: Number(e.target.value) } }, 'บันทึก override องก์...')} className="w-14 px-1 py-0.5 border border-gray-200 rounded" /> stop</label>
                <label className="flex items-center gap-1 text-gray-500">LUT องก์ <input type="file" accept=".cube" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const [url] = await uploadMany([f], 'films_lut'); act('/api/film/films', { action: 'update_act', act_id: actItem.id, style_override: { lut_url: url, lut_name: f.name } }, 'บันทึก LUT องก์...'); }} className="text-[10px] w-40" />{actItem.style_override?.lut_name && <span className="text-[#1A1A1A]">{actItem.style_override.lut_name}</span>}</label>
                <span className="ml-auto flex gap-1">
                  <button type="button" disabled={!!busy || ai === 0} onClick={() => act('/api/film/films', { action: 'move', kind: 'act', id: actItem.id, dir: -1 }, 'ย้าย...')} className="px-2 py-0.5 rounded border border-gray-300 bg-white disabled:opacity-30">↑</button>
                  <button type="button" disabled={!!busy || ai === actsSorted.length - 1} onClick={() => act('/api/film/films', { action: 'move', kind: 'act', id: actItem.id, dir: 1 }, 'ย้าย...')} className="px-2 py-0.5 rounded border border-gray-300 bg-white disabled:opacity-30">↓</button>
                </span>
              </div>
              {film.scenes.filter((s) => s.act_id === actItem.id).length === 0 && <p className="text-[11px] text-gray-400">ยังไม่มีฉากในองก์นี้</p>}
            {film.scenes.filter((s) => s.act_id === actItem.id).sort((a, b) => a.order - b.order).map((scene, si, scenesSorted) => {
              const master = film.masters.find((m) => m.id === scene.location_master_id);
              const report = gradeReport[scene.id];
              return (
                <div key={scene.id} className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] font-bold">ฉาก {scene.order}</span>
                    <span className="font-semibold text-[#1A1A1A]">{scene.name}</span>
                    <span className="text-gray-500">📍 {master?.name} v{master?.version} · {scene.time_of_day} · {scene.weather}</span>
                    {scene.anchor_frame_url ? <img src={scene.anchor_frame_url} alt="anchor" title="anchor frame" className="w-10 h-6 object-cover rounded border border-[#D4AF37]" /> : <span className="text-amber-700">ยังไม่มี anchor</span>}
                    <span className="flex gap-1">
                      <button type="button" disabled={!!busy || si === 0} onClick={() => act('/api/film/films', { action: 'move', kind: 'scene', id: scene.id, dir: -1 }, 'ย้าย...')} className="px-1.5 py-0.5 rounded border border-gray-300 bg-white disabled:opacity-30">↑</button>
                      <button type="button" disabled={!!busy || si === scenesSorted.length - 1} onClick={() => act('/api/film/films', { action: 'move', kind: 'scene', id: scene.id, dir: 1 }, 'ย้าย...')} className="px-1.5 py-0.5 rounded border border-gray-300 bg-white disabled:opacity-30">↓</button>
                      {(film.acts || []).length > 1 && (
                        <select value={scene.act_id} onChange={(e) => act('/api/film/films', { action: 'move_scene_to_act', scene_id: scene.id, act_id: e.target.value }, 'ย้ายฉาก...')} className="px-1 py-0.5 border border-gray-200 rounded bg-white text-[10px]">{[...film.acts].sort((a, b) => a.order - b.order).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                      )}
                    </span>
                    <label className="ml-auto flex items-center gap-1 text-gray-500">exposure <input type="number" step={0.25} min={-2} max={2} value={scene.style_override?.exposure_stops || 0} onChange={(e) => act('/api/film/scenes', { action: 'override', scene_id: scene.id, style_override: { exposure_stops: Number(e.target.value) } }, 'บันทึก override...')} className="w-14 px-1 py-0.5 border border-gray-200 rounded" /> stop</label>
                    <button type="button" disabled={!!busy || !scene.anchor_frame_url || !scene.shots.some((s) => s.pre_grade_url)} onClick={() => gradeScene(scene)} className="px-3 py-1.5 rounded-lg bg-[#1A1A1A] text-[#D4AF37] font-semibold disabled:opacity-40 flex items-center gap-1"><RefreshCw className="w-3 h-3" /> grade ทั้งฉาก (LUT + anchor)</button>
                    {film.masters.some((m) => m.kind === 'character' || m.kind === 'prop') && (
                      <button type="button" disabled={!!busy || !scene.shots.some((s) => s.pre_grade_url || s.post_grade_url)} onClick={async () => { const j = await act('/api/film/scenes', { action: 'check_continuity', scene_id: scene.id }, `กำลังตรวจ continuity ฉาก ${scene.name} (VLM)...`); if (j) setContReport((p) => ({ ...p, [scene.id]: j })); }} className="px-3 py-1.5 rounded-lg bg-white border border-[#D4AF37] font-semibold disabled:opacity-40 flex items-center gap-1" title="VLM เทียบทุกช็อตกับ continuity state ของฉาก (เสื้อผ้า/ผม/บาดแผล/พร็อพ/ความสกปรก)"><Shirt className="w-3 h-3" /> ตรวจ continuity</button>
                    )}
                  </div>
                  {contReport[scene.id] && (
                    <p className={`rounded-lg px-3 py-1.5 border ${contReport[scene.id].flagged ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-700'}`}>
                      continuity: ติดธง {contReport[scene.id].flagged}/{contReport[scene.id].results.length} ช็อต · {contReport[scene.id].results.map((r: any) => `ช็อต ${scene.shots.find((s) => s.id === r.shot_id)?.order}: ${r.passed === null ? 'ตรวจไม่ได้' : r.passed ? 'ผ่าน' : r.issues.join(' / ')}`).join(' | ')}
                    </p>
                  )}
                  {report && (
                    <p className={`rounded-lg px-3 py-1.5 border ${report.mean != null && report.mean < report.threshold ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                      ΔE เฉลี่ยของฉาก {report.mean ?? '-'} (เกณฑ์ &lt; {report.threshold}) · ติดธง {report.results.filter((r: any) => r.passed === false).length}/{report.results.length} ช็อต · {report.results.map((r: any) => `ช็อต ${scene.shots.find((s) => s.id === r.shot_id)?.order}: ${r.error ? r.error : `ΔE ${r.delta_e} · hist ${r.histogram ?? '-'} · style ${r.style ?? '-'}${r.retries ? ` · retry×${r.retries}` : ''}`}`).join(' | ')}
                    </p>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[...scene.shots].sort((a, b) => a.order - b.order).map((sh, shi, shotsSorted) => (
                      <div key={sh.id} className={`rounded-xl border p-2 space-y-1 ${sh.status === 'failed' ? 'border-red-300' : sh.status === 'approved' ? 'border-green-400' : sh.passed === false ? 'border-amber-300' : 'border-gray-200'}`}>
                        <div className="flex items-center gap-1.5 flex-wrap"><span className="font-semibold">ช็อต {sh.order}</span><span className="text-gray-500">{({ processing: 'กำลังสร้าง', ready: 'พร้อม grade', graded: 'grade แล้ว', approved: 'อนุมัติแล้ว', failed: 'ล้มเหลว', draft: 'ร่าง' } as any)[sh.status]}</span>{sh.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin" />}{sh.chain_frame_url && <span title="ต่อจากช็อตก่อนหน้า (เฟรมสุดท้ายเป็น reference)" className="text-[#D4AF37]">🔗</span>}{typeof sh.delta_e === 'number' && <span className={`ml-auto px-1.5 rounded-md ${sh.passed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800'}`}>ΔE {sh.delta_e}</span>}
                          <span className="flex gap-0.5">
                            <button type="button" disabled={!!busy || shi === 0} onClick={() => act('/api/film/films', { action: 'move', kind: 'shot', id: sh.id, dir: -1 }, 'ย้าย...')} className="px-1 rounded border border-gray-300 bg-white disabled:opacity-30">↑</button>
                            <button type="button" disabled={!!busy || shi === shotsSorted.length - 1} onClick={() => act('/api/film/films', { action: 'move', kind: 'shot', id: sh.id, dir: 1 }, 'ย้าย...')} className="px-1 rounded border border-gray-300 bg-white disabled:opacity-30">↓</button>
                            <button type="button" onClick={() => setShowStyle(showStyle === sh.id ? '' : sh.id)} title="effective style ที่ resolve แล้ว" className="px-1 rounded border border-gray-300 bg-white">ℹ︎</button>
                          </span>
                        </div>
                        {showStyle === sh.id && (
                          <pre className="text-[9px] leading-tight bg-gray-50 border border-gray-200 rounded-lg p-2 overflow-x-auto max-h-40">{JSON.stringify({ bible_v: sh.effective_style?.bible_version, lut: sh.effective_style?.lut_name || null, exposure: sh.effective_style?.exposure_stops, lighting: sh.effective_style?.lighting_rules, lens: sh.effective_style?.lens, location: sh.effective_style?.location?.name, master_v: sh.master_versions, chained: !!sh.chain_frame_url, continuity: sh.effective_style?.continuity_prompt || null, graded_with: sh.effective_style?.graded_with }, null, 1)}</pre>
                        )}
                        {(sh.post_grade_url || sh.pre_grade_url) ? <video src={sh.post_grade_url || sh.pre_grade_url} controls className="w-full rounded-lg bg-black" /> : <div className="aspect-video rounded-lg bg-gray-100" />}
                        {sh.qa && (
                          <div className={`rounded-lg px-2 py-1.5 border text-[10px] space-y-0.5 ${sh.qa.passed ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                            <div className="flex flex-wrap gap-x-2">
                              <span className="font-semibold">QA {sh.qa.passed ? 'ผ่าน' : 'ติดธง'}</span>
                              <span title="ΔE สีเฉลี่ยเทียบ anchor" className={sh.qa.color_delta_e != null && sh.qa.color_delta_e >= sh.qa.threshold_used.delta_e ? 'font-bold' : ''}>ΔE {sh.qa.color_delta_e ?? '-'} /{sh.qa.threshold_used.delta_e}</span>
                              <span title="histogram correlation เทียบ anchor" className={sh.qa.histogram_score != null && sh.qa.histogram_score < sh.qa.threshold_used.histogram ? 'font-bold' : ''}>hist {sh.qa.histogram_score ?? '-'} /≥{sh.qa.threshold_used.histogram}</span>
                              <span title="style distance (VLM) เทียบ anchor+master" className={sh.qa.style_distance != null && sh.qa.style_distance >= sh.qa.threshold_used.style ? 'font-bold' : ''}>style {sh.qa.style_distance ?? '-'} /{sh.qa.threshold_used.style}</span>
                              {sh.qa.auto_retry_count > 0 && <span>retry ×{sh.qa.auto_retry_count}</span>}
                            </div>
                            {sh.qa.style_notes && <p className="text-gray-600">{sh.qa.style_notes}</p>}
                          </div>
                        )}
                        {sh.continuity && (
                          <div className={`rounded-lg px-2 py-1.5 border text-[10px] space-y-0.5 ${sh.continuity.passed ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                            <span className="font-semibold">continuity {sh.continuity.passed ? 'ผ่าน' : 'ติดธง'}</span>
                            {sh.continuity.per_subject.map((p) => {
                              const name = film.masters.find((m) => m.id === p.subject_master_id)?.name || p.subject_master_id;
                              return <p key={p.subject_master_id} className="text-gray-600">{name}: {!p.present ? 'ไม่อยู่ในเฟรม' : p.consistent ? 'ตรงตาม state' : p.issues.join(' / ')}</p>;
                            })}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {sh.pre_grade_url && <button type="button" disabled={!!busy} onClick={() => act('/api/film/scenes', { action: 'set_anchor', scene_id: scene.id, shot_id: sh.id, at_seconds: 0.5 }, 'กำลังบันทึก anchor frame...')} className={`px-2 py-0.5 rounded-md border flex items-center gap-1 ${scene.anchor_from_shot_id === sh.id ? 'bg-[#D4AF37]/20 border-[#D4AF37]' : 'bg-white border-gray-300'}`}><Anchor className="w-3 h-3" /> {scene.anchor_from_shot_id === sh.id ? 'anchor ของฉาก' : 'ใช้เป็น anchor'}</button>}
                          {sh.post_grade_url && sh.pre_grade_url && <a href={sh.pre_grade_url} target="_blank" rel="noreferrer" className="px-2 py-0.5 rounded-md border border-gray-300 bg-white">ดู pre-grade</a>}
                          {sh.status !== 'processing' && sh.vfx_project_id && (
                            <button type="button" disabled={!!busy} onClick={() => { if (confirm('gen เลเยอร์ตัดคนของช็อตนี้ใหม่ (หักตามราคา matte) แล้ว grade ใหม่ ดำเนินการ?')) act('/api/film/scenes', { action: 'regen_layer', scene_id: scene.id, shot_id: sh.id, layer: 'matte' }, 'กำลังส่ง gen เลเยอร์ใหม่...'); }} className="px-2 py-0.5 rounded-md border border-gray-300 bg-white flex items-center gap-1" title="re-gen เฉพาะเลเยอร์ตัดคน (matte) — ฉากหลังและ grade ไม่เปลี่ยน"><RefreshCw className="w-3 h-3" /> gen ตัดคนใหม่</button>
                          )}
                          {(sh.status === 'ready' || sh.status === 'graded' || sh.status === 'approved') && (
                            <button type="button" disabled={!!busy} onClick={() => act('/api/film/scenes', { action: 'approve_shot', scene_id: scene.id, shot_id: sh.id, value: sh.status !== 'approved' }, sh.status === 'approved' ? 'เปิดช็อตใหม่...' : 'กำลังอนุมัติ...')} className={`px-2 py-0.5 rounded-md border flex items-center gap-1 ${sh.status === 'approved' ? 'bg-green-100 border-green-300 text-green-700' : 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]'}`}><CheckCircle2 className="w-3 h-3" /> {sh.status === 'approved' ? 'อนุมัติแล้ว (กดเพื่อเปิดใหม่)' : 'อนุมัติ → ปลดล็อกช็อตถัดไป'}</button>
                          )}
                        </div>
                        {sh.error && <p className="text-red-600">{sh.error}</p>}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-gray-100">
                    <input type="file" accept="video/mp4,video/quicktime" disabled={uploading || !!busy || !bibleLocked} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const [url] = await uploadMany([f], 'vfx_footage'); setShotFootage((p) => ({ ...p, [scene.id]: url })); }} className="text-[11px]" />
                    <button type="button" disabled={!shotFootage[scene.id] || !!busy || !bibleLocked} onClick={() => addShot(scene)} className="px-3 py-1.5 rounded-lg bg-white border border-[#D4AF37] font-semibold disabled:opacity-40 flex items-center gap-1"><Plus className="w-3 h-3" /> เพิ่มช็อตจากฟุตเทจ (ถ่ายบน plate ของ master)</button>
                    {!bibleLocked && <span className="text-amber-700">ล็อก Bible ก่อนจึงสร้างช็อตได้</span>}
                  </div>
                </div>
              );
            })}
            </div>
            ))}
          </section>
        </>
      )}
      {film && !film.scenes.length && film.masters.some((m) => m.locked) && <p className="text-[11px] text-gray-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> master พร้อมแล้ว — เพิ่มฉากที่อ้าง master นั้นได้เลย</p>}
    </div>
  );
}

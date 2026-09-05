'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { uploadToStorage } from '@/lib/supabase-db';
import { Layers, Loader2, CheckCircle2, AlertCircle, Film, Image as ImageIcon, Wand2, Scissors, Sparkles } from 'lucide-react';

/**
 * VFX Phase 0.5 — เปลี่ยนฉากหลังวิดีโอ. One shot, one new background, done.
 * The footage goes straight to storage (never through a function), the price is shown and
 * confirmed before anything is charged, and the job finishes on the server even if this
 * tab is closed — the result lands in the gallery either way.
 */

type Engine = 'matte' | 'o3';
type Grade = 'none' | 'warm' | 'cool' | 'cinematic';

const ENGINES: { id: Engine; label: string; creditsPerSec: number; min: number; max: number; blurb: string; tier: string }[] = [
  { id: 'matte', label: 'ตัดคน + วางฉากใหม่', creditsPerSec: 2, min: 1, max: 30, tier: 'ประหยัด', blurb: 'ตัดตัวคนออกจากฟุตเทจทุกเฟรม (veed) แล้ววางลงบนภาพฉากใหม่ ฉากหลังนิ่งคมชัดตามภาพ · ฟุตเทจไม่เกิน 30 วิ' },
  { id: 'o3', label: 'Kling O3 Edit (อัลตร้า)', creditsPerSec: 19, min: 3, max: 15, tier: 'อัลตร้า', blurb: 'AI เรนเดอร์ช็อตใหม่ทั้งเฟรม แสงเงาบนตัวคนกลมกลืนกับฉากใหม่ กล้องขยับตามได้ · ฟุตเทจ 3–15 วิ' }
];
const GRADES: { id: Grade; label: string }[] = [
  { id: 'none', label: 'ไม่ปรับสี' },
  { id: 'warm', label: 'โทนอุ่น' },
  { id: 'cool', label: 'โทนเย็น' },
  { id: 'cinematic', label: 'ซีเนมาติก (teal-orange)' }
];
const BG_IMAGE_CREDITS = 3;

interface FootageMeta { seconds: number; width: number; height: number }

export default function VfxBackgroundForm() {
  const { user } = useAuth();

  const [footageFile, setFootageFile] = useState<File | null>(null);
  const [footagePreview, setFootagePreview] = useState<string>('');
  const [footageUrl, setFootageUrl] = useState<string>('');
  const [footageMeta, setFootageMeta] = useState<FootageMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>('');

  const [bgMode, setBgMode] = useState<'prompt' | 'image'>('prompt');
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgPreview, setBgPreview] = useState<string>('');
  const [bgUrl, setBgUrl] = useState<string>('');
  const [bgUploading, setBgUploading] = useState(false);

  const [engine, setEngine] = useState<Engine>('matte');
  const [grade, setGrade] = useState<Grade>('none');
  const [confirmed, setConfirmed] = useState(false);

  const [status, setStatus] = useState<'idle' | 'submitting' | 'polling' | 'completed' | 'failed'>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const [resultBgUrl, setResultBgUrl] = useState('');
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  const safeName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(-60);

  const readVideoMeta = (file: File): Promise<FootageMeta> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        resolve({ seconds: v.duration, width: v.videoWidth, height: v.videoHeight });
        URL.revokeObjectURL(url);
      };
      v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('อ่านไฟล์วิดีโอไม่ได้ — รองรับ .mp4/.mov')); };
      v.src = url;
    });

  const handleFootage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    setFootageUrl('');
    setFootageMeta(null);
    setStatus('idle');
    setResultUrl('');
    setConfirmed(false);
    if (file.size > 200 * 1024 * 1024) { setUploadError('ไฟล์ใหญ่เกิน 200 MB'); return; }
    setFootageFile(file);
    setFootagePreview(URL.createObjectURL(file));
    try {
      const meta = await readVideoMeta(file);
      setFootageMeta(meta);
      setUploading(true);
      const path = `vfx_footage/${user?.email || 'unknown'}/${Date.now()}_${safeName(file.name)}`;
      const url = await uploadToStorage(file, path);
      setFootageUrl(url);
    } catch (err: any) {
      setUploadError(err.message || 'อัปโหลดฟุตเทจไม่สำเร็จ');
    } finally {
      setUploading(false);
    }
  };

  const handleBgImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgPreview(URL.createObjectURL(file));
    setBgUrl('');
    setBgUploading(true);
    try {
      const path = `vfx_backgrounds/${user?.email || 'unknown'}/${Date.now()}_${safeName(file.name)}`;
      setBgUrl(await uploadToStorage(file, path));
    } catch (err: any) {
      setError(err.message || 'อัปโหลดภาพฉากไม่สำเร็จ');
    } finally {
      setBgUploading(false);
    }
  };

  const secs = footageMeta ? Math.ceil(footageMeta.seconds) : 0;
  const engineDef = ENGINES.find((e) => e.id === engine)!;
  const engineFits = (e: typeof ENGINES[number]) => !secs || (secs >= e.min && secs <= e.max);
  const estimate = secs ? engineDef.creditsPerSec * secs + (bgMode === 'prompt' ? BG_IMAGE_CREDITS : 0) + 1 : 0;

  const bgReady = bgMode === 'prompt' ? bgPrompt.trim().length > 0 : !!bgUrl;
  const canSubmit = !!footageUrl && !!footageMeta && bgReady && engineFits(engineDef) && confirmed && status !== 'submitting' && status !== 'polling' && !uploading && !bgUploading;

  const poll = async (requestId: string, videoPath: string) => {
    try {
      const res = await fetch('/api/video-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, videoPath, modelType: 'vfx', storageProvider: 'supabase' })
      });
      const data = await res.json();
      if (data.status === 'COMPLETED') {
        setStatus('completed');
        setProgress(100);
        setResultUrl(data.videoUrl);
        return;
      }
      if (data.status === 'FAILED' || data.status === 'ERROR') {
        setStatus('failed');
        setError(data.error || 'งานล้มเหลว');
        return;
      }
      setProgress(data.progressPercent ?? 50);
      setMessage(data.progressMessage || 'กำลังประมวลผล...');
    } catch (err) {
      console.warn('[VFX poll]', err);
    }
    pollTimer.current = setTimeout(() => poll(requestId, videoPath), 8000);
  };

  const submit = async () => {
    if (!canSubmit || !footageMeta) return;
    setStatus('submitting');
    setError('');
    setResultUrl('');
    setProgress(5);
    setMessage(bgMode === 'prompt' ? 'กำลังสร้างภาพฉากหลังใหม่...' : 'กำลังส่งงาน...');
    try {
      const res = await fetch('/api/vfx/background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_email: user?.email || '',
          user_id: user?.id || '',
          footage_url: footageUrl,
          footage_seconds: footageMeta.seconds,
          footage_width: footageMeta.width,
          footage_height: footageMeta.height,
          engine,
          grade,
          background_prompt: bgMode === 'prompt' ? bgPrompt.trim() : '',
          background_image_url: bgMode === 'image' ? bgUrl : ''
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'เซิร์ฟเวอร์ปฏิเสธคำขอ');
      setResultBgUrl(data.backgroundUrl || '');
      setStatus('polling');
      setProgress(15);
      setMessage(engine === 'o3' ? '🎥 Kling O3 กำลังเรนเดอร์ช็อตใหม่...' : '✂️ กำลังตัดตัวคนออกจากฟุตเทจ...');
      poll(data.requestId, data.videoPath);
    } catch (err: any) {
      setStatus('failed');
      setError(err.message || 'ส่งงานไม่สำเร็จ');
    }
  };

  const busy = status === 'submitting' || status === 'polling';

  return (
    <div className="space-y-8">
      {/* 1. Footage */}
      <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2">
          <Film className="w-4 h-4 text-[#D4AF37]" /> 1. ฟุตเทจต้นฉบับ (คนแสดงจริง)
        </h3>
        <input
          type="file"
          accept="video/mp4,video/quicktime"
          onChange={handleFootage}
          disabled={busy}
          className="w-full text-xs text-gray-500 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#1A1A1A] file:text-[#D4AF37] hover:file:opacity-90 font-thai cursor-pointer"
        />
        {footagePreview && (
          <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
            <video src={footagePreview} controls className="w-full sm:w-64 rounded-xl bg-black border border-gray-200" />
            <div className="text-xs text-gray-600 font-thai space-y-1">
              {footageMeta && (
                <p>ความยาว {footageMeta.seconds.toFixed(1)} วิ · {footageMeta.width}×{footageMeta.height}</p>
              )}
              {uploading && <p className="flex items-center gap-1.5 text-[#D4AF37]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังอัปโหลดตรงเข้าคลัง (ไม่ผ่านเซิร์ฟเวอร์)...</p>}
              {footageUrl && <p className="flex items-center gap-1.5 text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> อัปโหลดแล้ว</p>}
              {uploadError && <p className="text-red-500">{uploadError}</p>}
              <p className="text-gray-400">ถ่ายให้คนเต็มตัวหรือครึ่งตัวชัด ฉากหลังเดิมไม่ต้องเป็นสีเขียว</p>
            </div>
          </div>
        )}
      </section>

      {/* 2. New background */}
      <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-[#D4AF37]" /> 2. ฉากหลังใหม่
        </h3>
        <div className="flex gap-1 rounded-xl border border-gray-200 bg-white p-0.5 w-fit">
          {([['prompt', 'บรรยายให้ระบบสร้างภาพ'], ['image', 'อัปโหลดภาพฉากเอง']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => setBgMode(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold font-thai transition-all ${bgMode === id ? 'bg-[#1A1A1A] text-[#D4AF37]' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {bgMode === 'prompt' ? (
          <textarea
            value={bgPrompt}
            onChange={(e) => setBgPrompt(e.target.value)}
            disabled={busy}
            rows={3}
            placeholder="เช่น ห้องแล็บวิทยาศาสตร์สมัยใหม่ แสงธรรมชาติจากหน้าต่างด้านซ้าย โต๊ะทดลองสีขาว"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl text-sm font-thai focus:outline-none focus:ring-1 focus:ring-[#D4AF37]"
          />
        ) : (
          <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
            <input
              type="file"
              accept="image/*"
              onChange={handleBgImage}
              disabled={busy}
              className="text-xs text-gray-500 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#1A1A1A] file:text-[#D4AF37] font-thai cursor-pointer"
            />
            {bgPreview && <img src={bgPreview} alt="ฉากหลังใหม่" className="w-full sm:w-48 rounded-xl border border-gray-200 object-cover" />}
            {bgUploading && <Loader2 className="w-4 h-4 text-[#D4AF37] animate-spin" />}
          </div>
        )}
        <p className="text-[11px] text-gray-400 font-thai">ภาพฉากควรเป็นสถานที่ว่างไม่มีคน มุมกล้องระดับสายตาใกล้เคียงฟุตเทจ</p>
      </section>

      {/* 3. Engine + grade */}
      <section className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#D4AF37]" /> 3. เครื่องยนต์และการปรับสี
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ENGINES.map((e) => {
            const fits = engineFits(e);
            return (
              <button
                key={e.id}
                type="button"
                disabled={busy || !fits}
                onClick={() => setEngine(e.id)}
                className={`text-left p-4 rounded-2xl border-2 transition-all disabled:opacity-40 ${engine === e.id ? 'border-[#D4AF37] bg-white shadow-sm' : 'border-gray-200 bg-white/60 hover:border-gray-300'}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-[#1A1A1A] font-thai flex items-center gap-1.5">
                    {e.id === 'matte' ? <Scissors className="w-4 h-4 text-[#D4AF37]" /> : <Wand2 className="w-4 h-4 text-[#D4AF37]" />} {e.label}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1A1A1A] text-[#D4AF37] font-thai">{e.tier} · {e.creditsPerSec} เครดิต/วิ</span>
                </div>
                <p className="text-[11px] text-gray-500 font-thai leading-relaxed">{e.blurb}</p>
                {!fits && secs > 0 && <p className="text-[11px] text-red-500 font-thai mt-1">ฟุตเทจ {secs} วิ ไม่อยู่ในช่วง {e.min}–{e.max} วิของเครื่องยนต์นี้</p>}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-600 font-thai">ปรับสี (grade):</span>
          {GRADES.map((g) => (
            <button
              key={g.id}
              type="button"
              disabled={busy}
              onClick={() => setGrade(g.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-thai border transition-all ${grade === g.id ? 'bg-[#1A1A1A] text-[#D4AF37] border-[#1A1A1A]' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </section>

      {/* 4. Confirm + run */}
      <section className="rounded-2xl border border-[#D4AF37]/40 bg-[#D4AF37]/5 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-thai">
            <p className="text-sm font-semibold text-[#1A1A1A] flex items-center gap-2"><Sparkles className="w-4 h-4 text-[#D4AF37]" /> ประเมินค่าใช้จ่าย</p>
            <p className="text-xs text-gray-600 mt-1">
              {secs
                ? `${engineDef.label} ${secs} วิ × ${engineDef.creditsPerSec} = ${engineDef.creditsPerSec * secs} เครดิต${bgMode === 'prompt' ? ` + สร้างภาพฉาก ${BG_IMAGE_CREDITS}` : ''} + ค่าดำเนินการ 1`
                : 'อัปโหลดฟุตเทจก่อนเพื่อคำนวณ'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-display font-bold text-[#1A1A1A]">{estimate || '—'}</p>
            <p className="text-[10px] text-gray-500 font-thai">เครดิต (หักตามนี้)</p>
          </div>
        </div>
        <label className="flex items-start gap-2 text-xs text-gray-700 font-thai cursor-pointer">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy || !estimate} className="mt-0.5 accent-[#D4AF37]" />
          ยืนยันให้หัก {estimate || 0} เครดิตและเริ่มงาน — งานจะเดินต่อจนเสร็จแม้ปิดแท็บ ผลจะขึ้นใน "คลังผลงาน"
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="w-full py-3.5 bg-[#1A1A1A] hover:bg-black text-[#D4AF37] font-semibold rounded-xl shadow-md transition-all disabled:opacity-40 font-thai flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
          {busy ? message || 'กำลังทำงาน...' : 'เปลี่ยนฉากหลัง'}
        </button>
        {busy && (
          <div className="w-full bg-gray-200 rounded-full h-1.5">
            <div className="bg-[#D4AF37] h-1.5 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        )}
        {status === 'failed' && (
          <p className="text-xs text-red-600 font-thai flex items-start gap-1.5"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</p>
        )}
      </section>

      {status === 'completed' && resultUrl && (
        <section id="vfx-result" className="space-y-3">
          <h3 className="text-sm font-semibold text-[#1A1A1A] font-thai flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-600" /> เสร็จแล้ว</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-[11px] text-gray-500 font-thai mb-1">ก่อน</p>
              <video src={footagePreview} controls className="w-full rounded-xl bg-black border border-gray-200" />
            </div>
            <div>
              <p className="text-[11px] text-gray-500 font-thai mb-1">หลัง</p>
              <video src={resultUrl} controls className="w-full rounded-xl bg-black border border-[#D4AF37]" />
            </div>
          </div>
          {resultBgUrl && (
            <p className="text-[11px] text-gray-500 font-thai">
              ฉากหลังที่ใช้: <a href={resultBgUrl} target="_blank" rel="noreferrer" className="underline text-[#D4AF37]">เปิดภาพ</a>
            </p>
          )}
          <a href={resultUrl} download className="inline-block text-xs font-semibold text-[#1A1A1A] underline font-thai">ดาวน์โหลด MP4</a>
        </section>
      )}
    </div>
  );
}

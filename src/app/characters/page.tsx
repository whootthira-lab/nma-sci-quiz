'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import Navbar from '@/components/Navbar';
import { Loader2, Plus, Users, Trash2, ShieldAlert, Sparkles, Upload, X } from 'lucide-react';
import { getCharacters, createCharacter, deleteCharacter, uploadToStorage } from '@/lib/supabase-db';

interface Character {
  id: string;
  name: string;
  code: string;
  visual_description: string;
  negative_prompt?: string;
  avatar_front_url?: string;
  avatar_45_url?: string;
  avatar_side_url?: string;
}

export default function CharactersPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [characters, setCharacters] = useState<Character[]>([]);
  const [fetching, setFetching] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form States
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [visualDesc, setVisualDesc] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [angle45File, setAngle45File] = useState<File | null>(null);
  const [angle45Preview, setAngle45Preview] = useState<string | null>(null);
  const [sideFile, setSideFile] = useState<File | null>(null);
  const [sidePreview, setSidePreview] = useState<string | null>(null);

  const frontInputRef = useRef<HTMLInputElement>(null);
  const angle45InputRef = useRef<HTMLInputElement>(null);
  const sideInputRef = useRef<HTMLInputElement>(null);

  const fetchCharactersList = async () => {
    if (!user?.email) return;
    setFetching(true);
    try {
      const data = await getCharacters(user.email);
      setCharacters(data);
    } catch (err) {
      console.error('Failed to load characters:', err);
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.email) {
      fetchCharactersList();
    }
  }, [user?.email]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'front' | '45' | 'side') => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('กรุณาเลือกเฉพาะไฟล์รูปภาพเท่านั้น');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('ขนาดรูปภาพต้องไม่เกิน 8MB');
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    if (type === 'front') {
      setFrontFile(file);
      setFrontPreview(previewUrl);
    } else if (type === '45') {
      setAngle45File(file);
      setAngle45Preview(previewUrl);
    } else {
      setSideFile(file);
      setSidePreview(previewUrl);
    }
    setError(null);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !code.trim() || !visualDesc.trim()) {
      setError('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน (ชื่อ, รหัส, และรายละเอียดรูปลักษณ์)');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const email = user?.email || 'user';
      let avatar_front_url = '';
      let avatar_front_path = '';
      let avatar_45_url = '';
      let avatar_45_path = '';
      let avatar_side_url = '';
      let avatar_side_path = '';

      // Upload Front View if present
      if (frontFile) {
        avatar_front_path = `characters/${email}/${timestamp}_front.${frontFile.type.split('/')[1] || 'png'}`;
        avatar_front_url = await uploadToStorage(frontFile, avatar_front_path);
      }

      // Upload 45-degree View if present
      if (angle45File) {
        avatar_45_path = `characters/${email}/${timestamp}_45.${angle45File.type.split('/')[1] || 'png'}`;
        avatar_45_url = await uploadToStorage(angle45File, avatar_45_path);
      }

      // Upload Side View if present
      if (sideFile) {
        avatar_side_path = `characters/${email}/${timestamp}_side.${sideFile.type.split('/')[1] || 'png'}`;
        avatar_side_url = await uploadToStorage(sideFile, avatar_side_path);
      }

      await createCharacter({
        user_email: email,
        name,
        code,
        visual_description: visualDesc,
        negative_prompt: negativePrompt,
        avatar_front_url,
        avatar_front_path,
        avatar_45_url,
        avatar_45_path,
        avatar_side_url,
        avatar_side_path
      });

      // Reset Form & Refresh
      setName('');
      setCode('');
      setVisualDesc('');
      setNegativePrompt('');
      setFrontFile(null);
      setFrontPreview(null);
      setAngle45File(null);
      setAngle45Preview(null);
      setSideFile(null);
      setSidePreview(null);
      setShowAddForm(false);
      await fetchCharactersList();
    } catch (err: any) {
      console.error('Create character failed:', err);
      setError(err.message || 'เกิดข้อผิดพลาดในการสร้างโปรไฟล์ตัวละคร');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteClick = async (id: string) => {
    if (!confirm('ยืนยันลบตัวละครนี้พร้อมไฟล์รูปภาพอ้างอิงทั้งหมดหรือไม่? (การกระทำนี้ไม่สามารถกู้คืนได้)')) return;
    setDeletingId(id);
    try {
      await deleteCharacter(id);
      setCharacters(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('Failed to delete character:', err);
      setError('ลบตัวละครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen pb-12">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-display font-bold text-text-primary tracking-tight flex items-center gap-2">
              <Users className="w-7 h-7 text-[#D4AF37]" />
              คลังตัวละคร (Character Library)
            </h1>
            <p className="text-sm text-text-secondary mt-1 font-thai">
              บันทึกและจัดการคาแร็กเตอร์เพื่อนำไปใช้ในการเจนวิดีโอแบบคุมหน้าตาตัวละครให้ต่อเนื่อง
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="btn-primary flex items-center gap-2 self-start sm:self-center font-thai"
          >
            {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showAddForm ? 'ปิดแบบฟอร์ม' : 'เพิ่มตัวละครใหม่'}
          </button>
        </div>

        {/* Global Error Banner */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-accent-danger/10 border border-accent-danger/20 text-accent-danger text-sm font-thai flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Add Character Form Panel */}
        {showAddForm && (
          <form onSubmit={handleAddSubmit} className="mb-8 p-6 bg-surface-2 border border-white/5 rounded-2xl space-y-6 animate-scale-up">
            <h3 className="text-lg font-bold text-text-primary font-display flex items-center gap-2 border-b border-white/5 pb-3">
              <Sparkles className="w-5 h-5 text-[#D4AF37]" />
              เพิ่มตัวละครตัวใหม่เข้าสู่คลัง
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Name */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary font-thai">
                  ชื่อตัวละคร <span className="text-accent-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="เช่น สมชาย, มานี"
                  className="w-full bg-surface-3 border border-white/5 p-3 rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai"
                />
              </div>

              {/* Code */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary font-thai">
                  รหัสอ้างอิงตัวละคร <span className="text-accent-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="เช่น CH-001, MANI-01"
                  className="w-full bg-surface-3 border border-white/5 p-3 rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai"
                />
              </div>
            </div>

            {/* Prompt fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Visual Description */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary font-thai">
                  บรรยายลักษณะภายนอกที่คงเดิม (Visual Description) <span className="text-accent-danger">*</span>
                </label>
                <textarea
                  required
                  value={visualDesc}
                  onChange={e => setVisualDesc(e.target.value)}
                  rows={4}
                  placeholder="เช่น a 30-year-old Thai man, short black hair, wearing thin black glasses and a dark blue denim jacket. (แนะนำเขียนภาษาอังกฤษเพื่อความแม่นยำ)"
                  className="w-full bg-surface-3 border border-white/5 p-3.5 rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai resize-none"
                />
              </div>

              {/* Negative Prompt */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-secondary font-thai">
                  สิ่งที่ไม่ต้องการให้เกิดกับตัวละคร (Character Negative Prompt)
                </label>
                <textarea
                  value={negativePrompt}
                  onChange={e => setNegativePrompt(e.target.value)}
                  rows={4}
                  placeholder="เช่น hat, cap, mustache, beard, blurry, deformed face, wrong clothes"
                  className="w-full bg-surface-3 border border-white/5 p-3.5 rounded-xl text-sm text-text-primary placeholder-text-muted outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai resize-none"
                />
              </div>
            </div>

            {/* Images upload section */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary font-thai">
                รูปถ่ายตัวละครอ้างอิงรายมุม (Reference Images)
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Front view */}
                <div className="space-y-2">
                  <span className="text-xs text-text-muted font-thai">👤 1. รูปหน้าตรง (Front View)</span>
                  <div
                    onClick={() => frontInputRef.current?.click()}
                    className={`relative border-2 border-dashed rounded-xl p-4 cursor-pointer text-center transition-all ${
                      frontPreview ? 'border-accent-primary/40 bg-surface-3' : 'border-white/10 hover:border-[#D4AF37] bg-surface-3'
                    }`}
                  >
                    {frontPreview ? (
                      <div className="relative group">
                        <img src={frontPreview} alt="Front View" className="h-32 mx-auto object-cover rounded-lg" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFrontFile(null);
                            setFrontPreview(null);
                          }}
                          className="absolute top-1 right-1 p-1 bg-black/60 hover:bg-black/80 rounded-full text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="py-6">
                        <Upload className="w-6 h-6 text-text-muted mx-auto mb-1.5" />
                        <span className="text-xs font-thai text-text-secondary">อัปโหลดภาพหน้าตรง</span>
                      </div>
                    )}
                  </div>
                  <input ref={frontInputRef} type="file" accept="image/*" className="hidden" onChange={e => handleFileChange(e, 'front')} />
                </div>

                {/* 45 degree view */}
                <div className="space-y-2">
                  <span className="text-xs text-text-muted font-thai">📐 2. รูปมุม 45 องศา (45° View)</span>
                  <div
                    onClick={() => angle45InputRef.current?.click()}
                    className={`relative border-2 border-dashed rounded-xl p-4 cursor-pointer text-center transition-all ${
                      angle45Preview ? 'border-accent-primary/40 bg-surface-3' : 'border-white/10 hover:border-[#D4AF37] bg-surface-3'
                    }`}
                  >
                    {angle45Preview ? (
                      <div className="relative group">
                        <img src={angle45Preview} alt="45 Degree View" className="h-32 mx-auto object-cover rounded-lg" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAngle45File(null);
                            setAngle45Preview(null);
                          }}
                          className="absolute top-1 right-1 p-1 bg-black/60 hover:bg-black/80 rounded-full text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="py-6">
                        <Upload className="w-6 h-6 text-text-muted mx-auto mb-1.5" />
                        <span className="text-xs font-thai text-text-secondary">อัปโหลดภาพมุม 45 องศา</span>
                      </div>
                    )}
                  </div>
                  <input ref={angle45InputRef} type="file" accept="image/*" className="hidden" onChange={e => handleFileChange(e, '45')} />
                </div>

                {/* Side view */}
                <div className="space-y-2">
                  <span className="text-xs text-text-muted font-thai">👥 3. รูปมุมข้าง (Side View)</span>
                  <div
                    onClick={() => sideInputRef.current?.click()}
                    className={`relative border-2 border-dashed rounded-xl p-4 cursor-pointer text-center transition-all ${
                      sidePreview ? 'border-accent-primary/40 bg-surface-3' : 'border-white/10 hover:border-[#D4AF37] bg-surface-3'
                    }`}
                  >
                    {sidePreview ? (
                      <div className="relative group">
                        <img src={sidePreview} alt="Side View" className="h-32 mx-auto object-cover rounded-lg" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSideFile(null);
                            setSidePreview(null);
                          }}
                          className="absolute top-1 right-1 p-1 bg-black/60 hover:bg-black/80 rounded-full text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="py-6">
                        <Upload className="w-6 h-6 text-text-muted mx-auto mb-1.5" />
                        <span className="text-xs font-thai text-text-secondary">อัปโหลดภาพมุมข้าง</span>
                      </div>
                    )}
                  </div>
                  <input ref={sideInputRef} type="file" accept="image/*" className="hidden" onChange={e => handleFileChange(e, 'side')} />
                </div>
              </div>
            </div>

            {/* Form Footer Actions */}
            <div className="flex gap-3 pt-3 border-t border-white/5">
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary px-6 py-2.5 font-thai flex items-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {submitting ? 'กำลังบันทึกตัวละคร...' : 'บันทึกตัวละคร'}
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="btn-ghost px-6 py-2.5 font-thai"
              >
                ยกเลิก
              </button>
            </div>
          </form>
        )}

        {/* Loading characters state */}
        {fetching ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
            <p className="text-sm text-text-muted mt-4 font-thai">กำลังดึงข้อมูลคลังตัวละคร...</p>
          </div>
        ) : characters.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-24 text-center border border-white/5 rounded-2xl bg-surface-1">
            <div className="w-16 h-16 rounded-2xl bg-surface-2 flex items-center justify-center mb-4 border border-white/5">
              <Users className="w-8 h-8 text-text-muted" />
            </div>
            <h3 className="text-lg font-medium text-text-primary font-thai">คลังตัวละครว่างเปล่า</h3>
            <p className="text-sm text-text-muted mt-1 font-thai max-w-sm">
              คุณยังไม่มีตัวละครในคลังเลย เริ่มสร้างและเพิ่มตัวละครตัวแรกเพื่อให้ AI จดจำลักษณะคาแร็กเตอร์ของคุณได้ทันที!
            </p>
          </div>
        ) : (
          /* Characters Grid */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {characters.map((char) => (
              <div key={char.id} className="glow-card p-6 border border-white/5 rounded-2xl space-y-4 flex flex-col justify-between">
                <div>
                  {/* Header Title */}
                  <div className="flex items-center justify-between border-b border-white/5 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-text-primary font-display flex items-center gap-1.5">
                        {char.name}
                      </h3>
                      <span className="text-[10px] bg-accent-primary/10 text-accent-primary border border-accent-primary/20 px-2 py-0.5 rounded-md font-mono mt-1 inline-block">
                        Code: {char.code}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteClick(char.id)}
                      disabled={deletingId === char.id}
                      className="p-2.5 rounded-xl text-text-muted hover:text-accent-danger hover:bg-accent-danger/10 transition-all self-start"
                      title="ลบตัวละคร"
                    >
                      {deletingId === char.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-accent-danger" />
                      ) : (
                        <Trash2 className="w-4.5 h-4.5" />
                      )}
                    </button>
                  </div>

                  {/* Character visual properties */}
                  <div className="space-y-3.5 pt-3.5">
                    {/* Visual Description */}
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-text-secondary uppercase tracking-wider font-thai">ลักษณะทางกายภาพที่ควบคุม (Visuals):</span>
                      <p className="text-xs text-text-primary font-thai leading-relaxed bg-surface-3 p-2.5 rounded-xl border border-white/5 select-all font-mono">
                        {char.visual_description}
                      </p>
                    </div>

                    {/* Negative prompt if present */}
                    {char.negative_prompt && (
                      <div className="space-y-1">
                        <span className="text-[11px] font-bold text-[#D4AF37]/80 uppercase tracking-wider font-thai">ลบจุดบกพร่อง (Negative):</span>
                        <p className="text-xs text-text-secondary font-thai leading-relaxed bg-[#D4AF37]/5 p-2 rounded-lg border border-[#D4AF37]/10 font-mono">
                          {char.negative_prompt}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Reference images thumbnails */}
                <div className="pt-2 border-t border-white/5 space-y-2">
                  <span className="text-[11px] font-bold text-text-secondary uppercase tracking-wider font-thai block">รูปถ่ายที่อ้างอิงในคลัง (Uploaded Views):</span>
                  <div className="grid grid-cols-3 gap-2">
                    {/* Front view */}
                    <div className="bg-surface-3 rounded-lg overflow-hidden border border-white/5 p-1 text-center flex flex-col justify-between min-h-[100px]">
                      {char.avatar_front_url ? (
                        <img src={char.avatar_front_url} alt="Front" className="h-16 w-full object-cover rounded-md" />
                      ) : (
                        <div className="h-16 w-full bg-surface-2 rounded-md flex items-center justify-center">
                          <span className="text-[10px] text-text-muted font-thai">ไม่มีรูป</span>
                        </div>
                      )}
                      <span className="text-[9px] text-text-muted mt-1 font-thai block">หน้าตรง</span>
                    </div>

                    {/* 45 degree view */}
                    <div className="bg-surface-3 rounded-lg overflow-hidden border border-white/5 p-1 text-center flex flex-col justify-between min-h-[100px]">
                      {char.avatar_45_url ? (
                        <img src={char.avatar_45_url} alt="45 Degree" className="h-16 w-full object-cover rounded-md" />
                      ) : (
                        <div className="h-16 w-full bg-surface-2 rounded-md flex items-center justify-center">
                          <span className="text-[10px] text-text-muted font-thai">ไม่มีรูป</span>
                        </div>
                      )}
                      <span className="text-[9px] text-text-muted mt-1 font-thai block">มุม 45°</span>
                    </div>

                    {/* Side view */}
                    <div className="bg-surface-3 rounded-lg overflow-hidden border border-white/5 p-1 text-center flex flex-col justify-between min-h-[100px]">
                      {char.avatar_side_url ? (
                        <img src={char.avatar_side_url} alt="Side" className="h-16 w-full object-cover rounded-md" />
                      ) : (
                        <div className="h-16 w-full bg-surface-2 rounded-md flex items-center justify-center">
                          <span className="text-[10px] text-text-muted font-thai">ไม่มีรูป</span>
                        </div>
                      )}
                      <span className="text-[9px] text-text-muted mt-1 font-thai block">มุมข้าง</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

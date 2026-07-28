'use client';

import { useState, useEffect } from 'react';
import { Download, Trash2, Film, Clock, AlertCircle, RefreshCw, Loader2, Copy, Check, Cpu } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { getUserGenerations, deleteGeneration } from '@/lib/supabase-db';
import type { GenerationDoc } from '@/types';

interface VideoGalleryProps {
  refreshTrigger?: number;
}

export default function VideoGallery({ refreshTrigger }: VideoGalleryProps) {
  const { user } = useAuth();
  const [generations, setGenerations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyPrompt = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const modeLabel = (mode: string) => {
    if (!mode) return 'วิดีโอ';
    if (mode.startsWith('image-') || mode === 'text_to_image') return 'รูปภาพ';
    if (mode === 'text-to-video') return 'Text → Video';
    if (mode === 'image_to_video') return 'Image → Video';
    if (mode === 'motion-control' || mode === 'face-motion') return 'Face Motion';
    return mode;
  };

  const loadGenerations = async () => {
    if (!user?.email) return;
    setLoading(true);
    try {
      const gens = await getUserGenerations(user.email);
      setGenerations(gens);
    } catch (err) {
      console.error('Failed to load generations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGenerations();
  }, [user?.email, refreshTrigger]);

  const handleDelete = async (id: string, storagePath: string) => {
    if (!confirm('ต้องการลบวิดีโอนี้หรือไม่?')) return;
    setDeleting(id);
    try {
      await deleteGeneration(id, storagePath);
      setGenerations((prev) => prev.filter((g) => g.id !== id));
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(null);
    }
  };

  const handleDownload = async (videoUrl: string, filename: string) => {
    try {
      const response = await fetch(videoUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  const formatDate = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return new Intl.DateTimeFormat('th-TH', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  const getExpiryText = (expiresAt: any) => {
    if (!expiresAt) return '';
    const date = expiresAt.toDate ? expiresAt.toDate() : new Date(expiresAt);
    const now = new Date();
    const hoursLeft = Math.max(0, Math.round((date.getTime() - now.getTime()) / (1000 * 60 * 60)));
    if (hoursLeft <= 0) return 'หมดอายุแล้ว';
    return `เหลืออีก ${hoursLeft} ชม.`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
        <p className="text-sm text-text-muted mt-4">กำลังโหลดคลังวิดีโอ...</p>
      </div>
    );
  }

  if (generations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-2 flex items-center justify-center mb-4">
          <Film className="w-8 h-8 text-text-muted" />
        </div>
        <h3 className="text-lg font-medium text-text-primary font-thai">ยังไม่มีวิดีโอ</h3>
        <p className="text-sm text-text-muted mt-1 font-thai">
          เริ่มสร้างวิดีโอ AI แรกของคุณได้เลย!
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-medium text-text-secondary font-thai">
            ทั้งหมด {generations.length} วิดีโอ
          </h3>
          <p className="text-xs text-text-muted mt-0.5">วิดีโอจะถูกลบอัตโนมัติภายใน 24 ชม.</p>
        </div>
        <button onClick={loadGenerations} className="btn-ghost flex items-center gap-2 text-sm">
          <RefreshCw className="w-3.5 h-3.5" />
          รีเฟรช
        </button>
      </div>

      {/* Video Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {generations.map((gen) => (
          <div key={gen.id} className="glow-card overflow-hidden">
            {/* Video Player */}
            {gen.status === 'completed' && gen.video_url ? (
              <div className="relative aspect-video bg-black rounded-t-2xl overflow-hidden">
                <video
                  src={gen.video_url}
                  controls
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
              </div>
            ) : gen.status === 'processing' ? (
              <div className="aspect-video bg-surface-2 rounded-t-2xl flex items-center justify-center">
                <div className="text-center">
                  <Loader2 className="w-8 h-8 text-accent-primary animate-spin mx-auto" />
                  <p className="text-xs text-text-muted mt-2 font-thai">กำลังประมวลผล...</p>
                </div>
              </div>
            ) : (
              <div className="aspect-video bg-surface-2 rounded-t-2xl flex items-center justify-center">
                <div className="text-center">
                  <AlertCircle className="w-8 h-8 text-accent-danger mx-auto" />
                  <p className="text-xs text-accent-danger mt-2 font-thai">เกิดข้อผิดพลาด</p>
                </div>
              </div>
            )}

            {/* Card Body */}
            <div className="p-4 space-y-3">
              {/* Mode Badge + Date */}
              <div className="flex items-center justify-between">
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${(gen.mode || '').startsWith('image')
                    ? 'bg-accent-warm/10 text-accent-warm'
                    : 'bg-accent-primary/10 text-accent-primary'
                  }`}>
                  {modeLabel(gen.mode)}
                </span>
                <span className="text-[10px] text-text-muted flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {getExpiryText(gen.expires_at)}
                </span>
              </div>

              {/* Prompt (คำสั่งที่ใช้สร้าง) */}
              {gen.prompt && (
                <div className="space-y-1.5">
                  <p className={`text-sm text-text-secondary font-thai whitespace-pre-wrap ${expandedId === gen.id ? '' : 'line-clamp-2'}`}>
                    {gen.prompt}
                  </p>
                  <div className="flex items-center gap-3">
                    {gen.prompt.length > 90 && (
                      <button
                        onClick={() => setExpandedId(expandedId === gen.id ? null : gen.id)}
                        className="text-[10px] text-accent-primary hover:underline"
                      >
                        {expandedId === gen.id ? 'ย่อ' : 'ดู Prompt เต็ม'}
                      </button>
                    )}
                    <button
                      onClick={() => handleCopyPrompt(gen.id, gen.prompt)}
                      className="text-[10px] text-text-muted hover:text-text-secondary flex items-center gap-1"
                    >
                      {copiedId === gen.id ? <Check className="w-3 h-3 text-accent-primary" /> : <Copy className="w-3 h-3" />}
                      {copiedId === gen.id ? 'คัดลอกแล้ว' : 'คัดลอก'}
                    </button>
                  </div>
                </div>
              )}

              {/* Meta: โมเดลที่ใช้ + วันที่ */}
              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                {gen.model_name && (
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-white/5 text-text-secondary border border-white/10 flex items-center gap-1">
                    <Cpu className="w-3 h-3" /> {gen.model_name}
                  </span>
                )}
                <span className="text-[10px] text-text-muted">{formatDate(gen.created_at)}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                {gen.status === 'completed' && gen.video_url && (
                  <button
                    onClick={() => handleDownload(gen.video_url, `video-${gen.id}.mp4`)}
                    className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                  >
                    <Download className="w-3.5 h-3.5" />
                    ดาวน์โหลด
                  </button>
                )}
                <button
                  onClick={() => handleDelete(gen.id, gen.storage_path)}
                  disabled={deleting === gen.id}
                  className="p-2 rounded-xl text-text-muted hover:text-accent-danger hover:bg-accent-danger/10 transition-all"
                >
                  {deleting === gen.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Upload,
  ImagePlus,
  Video,
  Wand2,
  AlertCircle,
  X,
  ChevronDown,
  Scan,
} from 'lucide-react';
import ProcessingOverlay from './ProcessingOverlay';
import { FACE_MOTION_MODELS } from '@/types';
import { useAuth } from '@/lib/auth-context';

interface Mode2FormProps {
  onVideoGenerated: () => void;
}

export default function Mode2Form({ onVideoGenerated }: Mode2FormProps) {
  const { user } = useAuth();
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [drivingVideo, setDrivingVideo] = useState<File | null>(null);
  const [drivingVideoName, setDrivingVideoName] = useState('');
  const [selectedModel, setSelectedModel] = useState(FACE_MOTION_MODELS[0].id);
  const [processing, setProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('กรุณาเลือกไฟล์รูปภาพเท่านั้น');
      return;
    }
    setImageFile(file);
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleVideoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setError('กรุณาเลือกไฟล์วิดีโอเท่านั้น');
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setError('ขนาดไฟล์วิดีโอต้องไม่เกิน 100MB');
      return;
    }
    setDrivingVideo(file);
    setDrivingVideoName(file.name);
    setError(null);
  }, []);

  const handleSubmit = async () => {
    if (!imageFile || !drivingVideo) {
      setError('กรุณาอัพโหลดทั้งรูปภาพและวิดีโอต้นแบบ');
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      setProcessingStage('กำลังอัพโหลดไฟล์...');
      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('driving_video', drivingVideo);
      formData.append('mode', 'face-motion');
      formData.append('model_id', selectedModel);
      formData.append('user_email', user?.email || '');

      const model = FACE_MOTION_MODELS.find(m => m.id === selectedModel);
      setProcessingStage(`กำลังประมวลผลด้วย ${model?.name || 'AI'}...`);

      const response = await fetch('/api/face-motion', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'เกิดข้อผิดพลาดในการสร้างวิดีโอ');
      }

      setProcessingStage('สร้างวิดีโอเสร็จสมบูรณ์!');
      await new Promise(r => setTimeout(r, 1000));

      // Reset
      setImageFile(null);
      setImagePreview(null);
      setDrivingVideo(null);
      setDrivingVideoName('');
      onVideoGenerated();
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาด');
    } finally {
      setProcessing(false);
      setProcessingStage('');
    }
  };

  return (
    <>
      <ProcessingOverlay isVisible={processing} stage={processingStage} />

      <div className="space-y-6">
        {/* Error */}
        {error && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-accent-danger/10 border border-accent-danger/20 animate-fade-in">
            <AlertCircle className="w-4 h-4 text-accent-danger flex-shrink-0" />
            <p className="text-sm text-accent-danger font-thai">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto">
              <X className="w-4 h-4 text-accent-danger/60" />
            </button>
          </div>
        )}

        {/* Model Selection */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary">
            <Scan className="inline w-4 h-4 mr-1.5 -mt-0.5" />
            เลือก AI Model
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FACE_MOTION_MODELS.map((model) => (
              <div
                key={model.id}
                onClick={() => setSelectedModel(model.id)}
                className={`p-4 rounded-xl cursor-pointer transition-all duration-200 ${
                  selectedModel === model.id
                    ? 'bg-accent-primary/10 border border-accent-primary/30'
                    : 'bg-surface-2/50 border border-white/5 hover:border-white/10'
                }`}
              >
                <p className="text-sm font-semibold text-text-primary">{model.name}</p>
                <p className="text-xs text-text-muted mt-1 font-thai">{model.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Reference Image Upload */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary">
            รูปภาพใบหน้า (Reference Face)
          </label>
          <div
            onClick={() => imageInputRef.current?.click()}
            className={`relative group cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden ${
              imagePreview
                ? 'border-accent-primary/30'
                : 'border-white/10 hover:border-accent-primary/30'
            }`}
          >
            {imagePreview ? (
              <div className="relative">
                <img src={imagePreview} alt="Preview" className="w-full h-48 object-cover" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <p className="text-white text-sm">คลิกเพื่อเปลี่ยนรูป</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setImageFile(null);
                    setImagePreview(null);
                  }}
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="w-14 h-14 rounded-2xl bg-accent-primary/10 flex items-center justify-center mb-4">
                  <ImagePlus className="w-7 h-7 text-accent-primary" />
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">อัพโหลดรูปใบหน้า</p>
                <p className="text-xs text-text-muted">ภาพนิ่ง หน้าตรง แสงดี</p>
              </div>
            )}
          </div>
          <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
        </div>

        {/* Driving Video Upload */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary">
            <Video className="inline w-4 h-4 mr-1.5 -mt-0.5" />
            วิดีโอต้นแบบ (Driving Video)
          </label>
          <div
            onClick={() => videoInputRef.current?.click()}
            className={`flex items-center gap-3 px-4 py-4 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
              drivingVideo
                ? 'border-accent-success/30 bg-accent-success/5'
                : 'border-white/10 hover:border-accent-primary/30'
            }`}
          >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              drivingVideo ? 'bg-accent-success/10' : 'bg-surface-3'
            }`}>
              <Video className={`w-5 h-5 ${drivingVideo ? 'text-accent-success' : 'text-text-muted'}`} />
            </div>
            <div>
              {drivingVideo ? (
                <>
                  <p className="text-sm font-medium text-accent-success">{drivingVideoName}</p>
                  <p className="text-xs text-text-muted">คลิกเพื่อเปลี่ยนไฟล์</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-text-primary">อัพโหลดวิดีโอต้นแบบ</p>
                  <p className="text-xs text-text-muted">MP4, WebM (สูงสุด 100MB)</p>
                </>
              )}
            </div>
          </div>
          <input ref={videoInputRef} type="file" accept="video/*" onChange={handleVideoChange} className="hidden" />
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!imageFile || !drivingVideo || processing}
          className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base"
        >
          <Scan className="w-5 h-5" />
          <span className="font-thai">สร้าง Face Motion Video</span>
        </button>
      </div>
    </>
  );
}

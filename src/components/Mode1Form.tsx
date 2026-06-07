'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload,
  ImagePlus,
  Type,
  Wand2,
  Clock,
  RectangleHorizontal,
  Square,
  Smartphone,
  AlertCircle,
  X,
  Settings
} from 'lucide-react';
import VoicePreview from './VoicePreview';
import ProcessingOverlay from './ProcessingOverlay';
import ImageCropperModal from './ImageCropperModal';
import { ASPECT_RATIOS, THAI_VOICES } from '@/types';
import { useAuth } from '@/lib/auth-context';

interface Mode1FormProps {
  onVideoGenerated: () => void;
}

export default function Mode1Form({ onVideoGenerated }: Mode1FormProps) {
  // ดึงสิทธิ์แอดมินของจริงมาใช้แล้วครับ (ไม่มีการแฮกโค้ดแล้ว)
  const { user, isAdmin } = useAuth(); 

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState('');
  const [situationPrompt, setSituationPrompt] = useState('');
  const [selectedVoice, setSelectedVoice] = useState(THAI_VOICES[0].id);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  
  // Storage & TTS Providers
  const [storageProvider, setStorageProvider] = useState<'supabase' | 'firebase'>('supabase');
  const ttsProvider = 'botnoi';

  // KRUTH Engine Model Selection
  const [modelType, setModelType] = useState('fast'); 
  const isMotionControl = modelType === 'motion-control';
  const isGrok = modelType === 'grok-video';

  // Safety filter and legal liability modal states
  const [safetyFilterDisabled, setSafetyFilterDisabled] = useState<boolean>(false);
  const [showLiabilityModal, setShowLiabilityModal] = useState<boolean>(false);

  // Kling v2.6 Motion Control states
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [motionAudioSource, setMotionAudioSource] = useState<'video' | 'botnoi'>('video');
  const videoInputRef = useRef<HTMLInputElement>(null);

  // Cropper states
  const [showCropper, setShowCropper] = useState(false);
  const [tempImageSrc, setTempImageSrc] = useState<string | null>(null);

  // Selected duration (5, 10, 15, 25 seconds)
  const [selectedDuration, setSelectedDuration] = useState<number>(5);

  // Progress state
  const [processingProgress, setProcessingProgress] = useState<number | undefined>(undefined);

  // Helper for dynamic preview aspect ratio
  const getPreviewAspectClass = () => {
    if (aspectRatio === '16:9') return 'aspect-[16/9] max-h-72 w-full object-cover mx-auto';
    if (aspectRatio === '9:16') return 'aspect-[9/16] max-h-[450px] w-full object-cover mx-auto';
    return 'aspect-square max-h-80 w-full object-cover mx-auto';
  };

  // Adjust selected duration if model changes and previous duration is invalid
  useEffect(() => {
    const validOptions = modelType === 'cinema'
      ? [5, 10, 15, 25]
      : (modelType === 'grok-video' ? [5, 10, 15] : [5, 10]);
    if (!validOptions.includes(selectedDuration)) {
      setSelectedDuration(5);
    }
  }, [modelType, selectedDuration]);

  const durationOptions = modelType === 'cinema'
    ? [5, 10, 15, 25]
    : (modelType === 'grok-video' ? [5, 10, 15] : [5, 10]);
  
  // สถานะการทำงาน
  const [processing, setProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);



  // คำนวณความยาว (15 อักษรไทย = 1 วินาที)
  const charCount = scriptText.replace(/\s+/g, '').length;
  const maxChars = 300;
  const estimatedDuration = Math.max(3, Math.ceil(charCount / 15));

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('กรุณาเลือกไฟล์รูปภาพเท่านั้น');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('ขนาดไฟล์ต้องไม่เกิน 10MB');
      return;
    }
    setError(null);

    // Bypass cropper for motion-control
    if (modelType === 'motion-control') {
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
      if (e.target) {
        e.target.value = '';
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      setTempImageSrc(ev.target?.result as string);
      setShowCropper(true);
    };
    reader.readAsDataURL(file);
    if (e.target) {
      e.target.value = '';
    }
  }, [modelType]);

  const handleVideoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setError('กรุณาเลือกไฟล์วิดีโอเท่านั้น');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('ขนาดไฟล์วิดีโอต้องไม่เกิน 20MB');
      return;
    }
    setError(null);
    setVideoFile(file);
    setVideoPreview(URL.createObjectURL(file));
    if (e.target) {
      e.target.value = '';
    }
  }, []);

  const handleCropComplete = useCallback((croppedFile: File, croppedUrl: string) => {
    setImageFile(croppedFile);
    setImagePreview(croppedUrl);
    setShowCropper(false);
    setTempImageSrc(null);
  }, []);

  // ฟังก์ชันทวงงาน (Polling)
  const pollStatus = async (requestId: string, videoPath: string, currentStorageProvider: 'supabase' | 'firebase') => {
    try {
      const statusRes = await fetch('/api/video-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, videoPath, modelType, storageProvider: currentStorageProvider })
      });
      
      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        setProcessingStage('✅ เสร็จสมบูรณ์! กำลังพาท่านไปที่แกลลอรี่...');
        setProcessingProgress(100);
        setTimeout(() => {
          setImageFile(null);
          setImagePreview(null);
          setScriptText('');
          setSituationPrompt('');
          setProcessing(false);
          setProcessingProgress(undefined);
          onVideoGenerated();
        }, 1500);
        return; 
      } else if (statusData.status === 'FAILED' || statusData.status === 'ERROR') {
        throw new Error(statusData.error || 'AI ประมวลผลล้มเหลว กรุณาลองใหม่อีกครั้ง');
      } else {
        if (statusData.progressMessage) {
          setProcessingStage(statusData.progressMessage);
        } else {
          if (statusData.status === 'IN_QUEUE') {
            setProcessingStage('⏳ KRUTH Engine กำลังจัดคิวประมวลผล...');
          } else if (statusData.status === 'IN_PROGRESS') {
            setProcessingStage('🔄 KRUTH Engine กำลังสร้างสรรค์วิดีโอ...');
          }
        }
        if (statusData.progressPercent !== undefined) {
          setProcessingProgress(statusData.progressPercent);
        }
        setTimeout(() => pollStatus(requestId, videoPath, currentStorageProvider), 8000);
      }
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาดในการตรวจสอบสถานะ');
      setProcessing(false);
      setProcessingProgress(undefined);
    }
  };

  const executeSubmit = async () => {
    setShowLiabilityModal(false);
    setProcessing(true);
    setProcessingProgress(0);
    setError(null);

    try {
      setProcessingStage('กำลังอัพโหลดข้อมูลเข้าสู่ KRUTH Engine...');
      setProcessingProgress(5);
      const formData = new FormData();
      formData.append('image', imageFile!);
      if (modelType === 'motion-control') {
        formData.append('video', videoFile!);
        formData.append('motion_audio_source', motionAudioSource);
        formData.append('script_text', motionAudioSource === 'botnoi' ? scriptText : '');
      } else {
        formData.append('script_text', scriptText);
      }
      formData.append('situation_prompt', situationPrompt);
      formData.append('voice_id', selectedVoice);
      formData.append('aspect_ratio', aspectRatio);
      formData.append('user_email', user?.email || 'user@kruth.com');
      formData.append('user_id', user?.id || '');
      formData.append('model_type', modelType);
      formData.append('storage_provider', storageProvider);
      formData.append('tts_provider', ttsProvider);
      formData.append('duration', String(selectedDuration));
      formData.append('safety_filter_disabled', String(safetyFilterDisabled));

      const response = await fetch('/api/generate-video', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'เกิดข้อผิดพลาดในการส่งคำสั่งสร้างวิดีโอ');
      }

      setProcessingStage('🚀 ส่งงานสำเร็จ! กำลังเชื่อมต่อระบบ AI...');
      setProcessingProgress(15);
      setTimeout(() => pollStatus(result.requestId, result.videoPath, storageProvider), 3000);

    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาด');
      setProcessing(false);
      setProcessingStage('');
      setProcessingProgress(undefined);
    }
  };

  const handleSubmit = async () => {
    if (modelType === 'motion-control') {
      if (!imageFile || !videoFile) {
        setError('กรุณาอัพโหลดรูปภาพและวิดีโอต้นแบบ');
        return;
      }
      if (motionAudioSource === 'botnoi' && !scriptText.trim()) {
        setError('กรุณากรอกบทพากย์สำหรับเสียง Botnoi');
        return;
      }
    } else {
      if (!imageFile || !scriptText.trim()) {
        setError('กรุณาอัพโหลดรูปภาพและกรอกบทพากย์');
        return;
      }
    }
    if (charCount > maxChars) {
      setError(`บทพากย์ต้องไม่เกิน ${maxChars} ตัวอักษร`);
      return;
    }

    // Check if we need to show the liability consent modal (safety filter disabled, or 18+/person lookalike keywords)
    const hasAdultKeywords = /18\+|adult|nude|sexy|NSFW|เสียว|โป๊|เปลือย|18 บวก|คนจริง|หน้าเหมือน/i.test(scriptText) || /18\+|adult|nude|sexy|NSFW|เสียว|โป๊|เปลือย|18 บวก|คนจริง|หน้าเหมือน/i.test(situationPrompt);
    
    if (safetyFilterDisabled || hasAdultKeywords) {
      setShowLiabilityModal(true);
      return;
    }

    await executeSubmit();
  };

  const aspectIcons: Record<string, React.ReactNode> = {
    '1:1': <Square className="w-4 h-4" />,
    '16:9': <RectangleHorizontal className="w-4 h-4" />,
    '9:16': <Smartphone className="w-4 h-4" />,
  };

  return (
    <>
      <ProcessingOverlay isVisible={processing} stage={processingStage} progress={processingProgress} />

      <div className="space-y-6">
        
        {/* Admin Model Selector */}
        {isAdmin && (
          <div className="space-y-3 p-3 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-xl mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[#D4AF37] font-semibold text-sm">
                <Settings className="w-4 h-4" />
                <span>Admin Engine Settings</span>
              </div>
              <select 
                value={modelType}
                onChange={(e) => setModelType(e.target.value)}
                className="bg-white border border-[#D4AF37] text-gray-800 text-sm rounded-lg px-2 py-1 outline-none font-thai cursor-pointer"
              >
                <option value="fast">⚡ KRUTH Standard (Kling 2.5 Turbo)</option>
                <option value="cinema">🎬 KRUTH Master (Wan 2.5 Cinema)</option>
                <option value="motion-control">🏃 KRUTH Motion (Kling 2.6 Motion Control)</option>
                <option value="grok-video">🌌 KRUTH Aurora (Grok Imagine Video v1.5)</option>
              </select>
            </div>
            
            {/* Content Safety Switch */}
            <div className="flex items-center justify-between border-t border-[#D4AF37]/20 pt-2 text-xs">
              <span className="text-gray-700 font-thai font-medium">ปิดระบบกรองเนื้อหาความปลอดภัย (Disable Safety Filter / NSFW)</span>
              <button
                type="button"
                onClick={() => setSafetyFilterDisabled(!safetyFilterDisabled)}
                className={`px-3 py-1 rounded-lg font-thai font-bold transition-all ${
                  safetyFilterDisabled
                    ? 'bg-accent-danger text-white hover:bg-accent-danger-hover shadow-sm'
                    : 'bg-white text-gray-600 border border-gray-300 hover:border-gray-400'
                }`}
              >
                {safetyFilterDisabled ? '🔴 ปิดการกรอง (NSFW On)' : '🟢 เปิดการกรอง (NSFW Off)'}
              </button>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-accent-danger/10 border border-accent-danger/20 animate-fade-in">
            <AlertCircle className="w-4 h-4 text-accent-danger flex-shrink-0" />
            <p className="text-sm text-accent-danger font-thai">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto">
              <X className="w-4 h-4 text-accent-danger/60" />
            </button>
          </div>
        )}

        {/* Aspect Ratio */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            อัตราส่วนวิดีโอ (Aspect Ratio)
          </label>
          {isMotionControl ? (
            <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600 font-thai flex items-center gap-2">
              <span>🔄 ปรับอัตราส่วนคลิปอัตโนมัติตามวิดีโอต้นแบบ (Auto-detect)</span>
            </div>
          ) : (
            <div className="flex gap-2">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  type="button"
                  onClick={() => setAspectRatio(ratio.value)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    aspectRatio === ratio.value
                      ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-md'
                      : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                  }`}
                >
                  {aspectIcons[ratio.value]}
                  <span className="font-thai">{ratio.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Image Upload */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            รูปภาพอ้างอิง (Reference Image)
          </label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`relative group cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden ${
              imagePreview
                ? 'border-accent-primary/30'
                : 'border-gray-300 hover:border-[#D4AF37]'
            }`}
          >
            {imagePreview ? (
              <div className="relative">
                <img src={imagePreview} alt="Preview" className={getPreviewAspectClass()} />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <p className="text-white text-sm font-medium font-thai">คลิกเพื่อเปลี่ยนรูป</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setImageFile(null);
                    setImagePreview(null);
                  }}
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4 group-hover:bg-[#D4AF37]/10 transition-colors">
                  <ImagePlus className="w-7 h-7 text-gray-500 group-hover:text-[#D4AF37]" />
                </div>
                <p className="text-sm font-medium text-gray-700 mb-1 font-thai">
                  คลิกเพื่ออัพโหลดรูปภาพ
                </p>
                <p className="text-xs text-gray-400 font-thai">
                  รองรับ JPG, PNG, WebP (สูงสุด 10MB)
                </p>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
        </div>

        {/* Video Upload for Motion Control */}
        {isMotionControl && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-secondary font-thai">
              วิดีโอต้นแบบการเคลื่อนไหว (Reference Video)
            </label>
            <div
              onClick={() => videoInputRef.current?.click()}
              className={`relative group cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden ${
                videoPreview
                  ? 'border-accent-primary/30'
                  : 'border-gray-300 hover:border-[#D4AF37]'
              }`}
            >
              {videoPreview ? (
                <div className="relative p-2 bg-black/5 flex items-center justify-center">
                  <video src={videoPreview} controls className="max-h-60 w-full object-contain rounded-lg" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setVideoFile(null);
                      setVideoPreview(null);
                    }}
                    className="absolute top-4 right-4 p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 px-4">
                  <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4 group-hover:bg-[#D4AF37]/10 transition-colors">
                    <Upload className="w-7 h-7 text-gray-500 group-hover:text-[#D4AF37]" />
                  </div>
                  <p className="text-sm font-medium text-gray-700 mb-1 font-thai">
                    คลิกเพื่ออัปโหลดวิดีโอต้นแบบ
                  </p>
                  <p className="text-xs text-gray-400 font-thai">
                    รองรับ MP4, WebM (สูงสุด 20MB)
                  </p>
                </div>
              )}
            </div>
            <input ref={videoInputRef} type="file" accept="video/*" onChange={handleVideoChange} className="hidden" />
          </div>
        )}

        {/* Audio Source Selection for Motion Control */}
        {isMotionControl && (
          <div className="space-y-2 p-3 bg-gray-50 border border-gray-200 rounded-xl">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider font-thai">
              แหล่งที่มาของเสียง (Audio Source)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMotionAudioSource('video')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                  motionAudioSource === 'video'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🎥 เสียงจากวิดีโอต้นแบบ
              </button>
              <button
                type="button"
                onClick={() => setMotionAudioSource('botnoi')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                  motionAudioSource === 'botnoi'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🤖 เสียงจาก Botnoi Voice
              </button>
            </div>
          </div>
        )}

        {/* Script Text */}
        {(!isMotionControl || (isMotionControl && motionAudioSource === 'botnoi')) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-text-secondary font-thai">
                <Type className="inline w-4 h-4 mr-1.5 -mt-0.5" />
                บทพากย์ (Script)
              </label>
              <span className={`text-xs font-mono ${charCount > maxChars ? 'text-accent-danger' : 'text-text-muted'}`}>
                {charCount}/{maxChars}
              </span>
            </div>
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="พิมพ์บทพากย์ภาษาไทยที่นี่... เช่น สวัสดีค่ะ วันนี้เราจะมาเรียนรู้เรื่อง..."
              rows={4}
              className="w-full bg-white border border-gray-200 p-4 rounded-xl text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai resize-none transition-all"
            />
            {scriptText.trim() && (
              <div className="flex items-center gap-4 text-xs text-gray-500 font-thai">
                <span className="flex items-center gap-1.5 bg-gray-100 px-2 py-1 rounded-md">
                  <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                  ความยาวคลิปประมาณ: {estimatedDuration} วินาที
                </span>
              </div>
            )}
          </div>
        )}

        {/* Situation Prompt */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            <Wand2 className="inline w-4 h-4 mr-1.5 -mt-0.5" />
            คำสั่งเพิ่มเติม (Optional Prompt)
          </label>
          <input
            type="text"
            value={situationPrompt}
            onChange={(e) => setSituationPrompt(e.target.value)}
            placeholder="เช่น smiling, professional tone, gentle head movements"
            className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai transition-all"
          />
        </div>

        {/* Storage Option Switches */}
        <div className="space-y-4 p-4 rounded-2xl bg-gray-50 border border-gray-150">
          {/* Storage Option */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider font-thai">
              สถานที่เก็บไฟล์คลิปวิดีโอ (Storage)
            </label>
            <div className="flex gap-2 max-w-md">
              <button
                type="button"
                onClick={() => setStorageProvider('supabase')}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  storageProvider === 'supabase'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🟢 Supabase
              </button>
              <button
                type="button"
                onClick={() => setStorageProvider('firebase')}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  storageProvider === 'firebase'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🔥 Firebase
              </button>
            </div>
          </div>
        </div>

        {/* Voice Selection */}
        {(!isMotionControl || (isMotionControl && motionAudioSource === 'botnoi')) && (
          <VoicePreview selectedVoice={selectedVoice} onSelect={setSelectedVoice} ttsProvider={ttsProvider} />
        )}

        {/* Video Duration */}
        {!isMotionControl && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-secondary font-thai">
              ความยาววิดีโอ (Video Duration)
            </label>
            <div className="flex gap-2">
              {durationOptions.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSelectedDuration(d)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    selectedDuration === d
                      ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                      : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                  }`}
                >
                  ⏱️ {d} วินาที
                </button>
              ))}
            </div>
          </div>
        )}



        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={
            processing ||
            !imageFile ||
            (modelType === 'motion-control' && !videoFile) ||
            (modelType !== 'motion-control' && !scriptText.trim()) ||
            (modelType === 'motion-control' && motionAudioSource === 'botnoi' && !scriptText.trim())
          }
          className="w-full bg-[#1A1A1A] text-[#D4AF37] hover:bg-black disabled:bg-gray-300 disabled:text-gray-500 py-4 rounded-xl font-bold text-lg shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2"
        >
          <Wand2 className="w-5 h-5" />
          <span className="font-thai">สร้างวิดีโอด้วย KRUTH Engine</span>
        </button>
      </div>

      {showCropper && tempImageSrc && (
        <ImageCropperModal
          imageSrc={tempImageSrc}
          aspectRatio={aspectRatio}
          onCrop={handleCropComplete}
          onClose={() => {
            setShowCropper(false);
            setTempImageSrc(null);
          }}
        />
      )}

      {showLiabilityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in font-thai">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-2xl max-w-lg w-full overflow-hidden animate-scale-up">
            {/* Header */}
            <div className="bg-accent-danger/10 border-b border-accent-danger/20 p-5 flex items-center gap-3">
              <AlertCircle className="w-7 h-7 text-accent-danger flex-shrink-0" />
              <div>
                <h3 className="text-lg font-bold text-accent-danger">คำเตือนและข้อตกลงการรับผิดชอบทางกฎหมาย</h3>
                <p className="text-xs text-accent-danger/80">กรุณาอ่านเงื่อนไขก่อนดำเนินการต่อ</p>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-800 leading-relaxed font-medium">
                เนื่องจากคุณเลือกปิดระบบกรองความปลอดภัย (NSFW/Safety Filter) หรือคำสั่งของคุณมีความละเอียดอ่อน เช่น เนื้อหา 18+ หรือมีความเป็นรูปภาพบุคคลใกล้เคียงคนจริง
              </p>
              <div className="p-4 bg-accent-danger/5 border border-accent-danger/20 rounded-xl text-xs text-gray-700 leading-relaxed space-y-2">
                <p className="font-bold text-accent-danger text-sm">ข้อกำหนดความรับผิดชอบ:</p>
                <p>1. ผู้ใช้บริการตกลงและยอมรับว่าจะเป็นผู้รับผิดชอบต่อความเสียหายและผลกระทบทางกฎหมายใดๆ ที่เกิดขึ้นจากการสร้าง แชร์ หรือนำวิดีโอนี้ไปใช้ แต่เพียงผู้เดียว</p>
                <p>2. ผู้ให้บริการแพลตฟอร์มนี้ (Platform Provider) ไม่มีส่วนเกี่ยวข้อง ไม่มีส่วนรับรู้ และจะไม่รับผิดชอบใดๆ ทั้งสิ้นในประเด็นทางกฎหมาย คดีความ หรือการละเมิดลิขสิทธิ์และสิทธิ์ส่วนบุคคลที่เกิดขึ้น</p>
              </div>
            </div>

            {/* Footer */}
            <div className="bg-gray-50 p-4 border-t border-gray-150 flex gap-3">
              <button
                type="button"
                onClick={() => setShowLiabilityModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors"
              >
                ยกเลิก (Cancel)
              </button>
              <button
                type="button"
                onClick={executeSubmit}
                className="flex-1 py-2.5 rounded-xl bg-accent-danger text-white font-bold hover:bg-accent-danger-hover transition-colors shadow-md"
              >
                ฉันยอมรับและขอรับผิดชอบเอง
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
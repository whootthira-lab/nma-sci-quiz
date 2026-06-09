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
  Settings,
  Sparkles
} from 'lucide-react';
import VoicePreview from './VoicePreview';
import ProcessingOverlay from './ProcessingOverlay';
import ImageCropperModal from './ImageCropperModal';
import { ASPECT_RATIOS, THAI_VOICES } from '@/types';
import { useAuth } from '@/lib/auth-context';
import { getCharacters, supabase } from '@/lib/supabase-db';

interface Character {
  id: string;
  name: string;
  code: string;
  visual_description: string;
  negative_prompt?: string;
  avatar_front_url?: string;
  avatar_front_path?: string;
  avatar_45_url?: string;
  avatar_45_path?: string;
  avatar_side_url?: string;
  avatar_side_path?: string;
  lora_status?: string;
  lora_job_id?: string;
  lora_model_url?: string;
  lora_trigger_word?: string;
  lora_steps?: number;
}

interface Mode1FormProps {
  onVideoGenerated: () => void;
}

export default function Mode1Form({ onVideoGenerated }: Mode1FormProps) {
  // ดึงสิทธิ์แอดมินของจริงมาใช้แล้วครับ (ไม่มีการแฮกโค้ดแล้ว)
  const { user, isAdmin, whitelistData } = useAuth(); 

  const [imageFile, setImageFile] = useState<File | null>(null);
  // สถานะการทำงาน
  const [processing, setProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [endImageFile, setEndImageFile] = useState<File | null>(null);
  const [endImagePreview, setEndImagePreview] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState('');
  const [situationPrompt, setSituationPrompt] = useState('');
  const [endSituationPrompt, setEndSituationPrompt] = useState('');
  const [selectedVoice, setSelectedVoice] = useState(THAI_VOICES[0].id);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [videoMode, setVideoMode] = useState<'image_to_video' | 'text_to_video'>('image_to_video');

  const [modelType, setModelType] = useState('fast'); 
  const isMotionControl = modelType === 'motion-control';
  const isGrok = modelType === 'grok-video';

  // If text-to-video mode is selected, make sure modelType is one that supports text-to-video
  useEffect(() => {
    if (videoMode === 'text_to_video') {
      if (modelType === 'motion-control' || modelType === 'ltx-video' || modelType === 'grok-video') {
        setModelType('fast');
      }
    }
  }, [videoMode, modelType]);

  // New premium states
  const [isNoSpeech, setIsNoSpeech] = useState(false);
  const [audioSourceType, setAudioSourceType] = useState<'tts' | 'upload'>('tts');
  const [customAudioFile, setCustomAudioFile] = useState<File | null>(null);
  const [customAudioPreview, setCustomAudioPreview] = useState<string | null>(null);
  const [customAudioDuration, setCustomAudioDuration] = useState(0);
  const [isAutoDuration, setIsAutoDuration] = useState(true);
  const [visualStyle, setVisualStyle] = useState('cinematic');

  // Character Library states
  const [characterList, setCharacterList] = useState<Character[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [selectedCharacterAngle, setSelectedCharacterAngle] = useState<'front' | '45' | 'side'>('front');
  const [useLoraModel, setUseLoraModel] = useState(false);

  // Speech Speed state
  const [speedFactor, setSpeedFactor] = useState(1.0);

  // Character Emotion state
  const [characterEmotion, setCharacterEmotion] = useState('');
  const [customEmotionText, setCustomEmotionText] = useState('');
  
  // Storage & TTS Providers
  const [storageProvider, setStorageProvider] = useState<'supabase' | 'firebase'>('supabase');
  const [ttsProvider, setTtsProvider] = useState<'google' | 'openai' | 'cosyvoice'>('google');



  // Safety filter and legal liability modal states
  const [safetyFilterDisabled, setSafetyFilterDisabled] = useState<boolean>(false);
  const [showLiabilityModal, setShowLiabilityModal] = useState<boolean>(false);

  // Kling v2.6 Motion Control states
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [motionAudioSource, setMotionAudioSource] = useState<'video' | 'tts'>('video');
  const videoInputRef = useRef<HTMLInputElement>(null);
  const endFileInputRef = useRef<HTMLInputElement>(null);
  const customAudioInputRef = useRef<HTMLInputElement>(null);

  // Cropper states
  const [showCropper, setShowCropper] = useState(false);
  const [tempImageSrc, setTempImageSrc] = useState<string | null>(null);
  const [croppingTarget, setCroppingTarget] = useState<'start' | 'end'>('start');

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

  // Load characters list on mount
  useEffect(() => {
    if (user?.email) {
      getCharacters(user.email).then(data => {
        setCharacterList(data);
      }).catch(err => {
        console.error('Failed to load characters in form:', err);
      });
    }
  }, [user?.email]);

  // Quota states and fetch hook
  const [todaysCount, setTodaysCount] = useState<number>(0);
  const [loadingQuota, setLoadingQuota] = useState(true);

  const fetchTodayQuota = useCallback(async () => {
    if (!user?.id) return;
    try {
      const localStartOfDay = new Date();
      localStartOfDay.setHours(0, 0, 0, 0);

      const { count, error } = await supabase
        .from('generations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', localStartOfDay.toISOString());

      if (!error && count !== null) {
        setTodaysCount(count);
      }
    } catch (err) {
      console.error('Error fetching today quota count:', err);
    } finally {
      setLoadingQuota(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchTodayQuota();
  }, [fetchTodayQuota, processing]);

  // Sync starting image preview from selected character avatar & angle
  useEffect(() => {
    if (!selectedCharacterId) {
      setUseLoraModel(false);
      return;
    }
    const char = characterList.find(c => c.id === selectedCharacterId);
    if (!char) return;

    if (char.lora_status === 'completed') {
      setUseLoraModel(true);
    } else {
      setUseLoraModel(false);
    }

    let url = '';
    if (selectedCharacterAngle === 'front') url = char.avatar_front_url || '';
    else if (selectedCharacterAngle === '45') url = char.avatar_45_url || '';
    else if (selectedCharacterAngle === 'side') url = char.avatar_side_url || '';

    if (url) {
      setImagePreview(url);
      setImageFile(null); // Clear manual file since we are using character template
    } else {
      setImagePreview(null);
      setImageFile(null);
    }
  }, [selectedCharacterId, selectedCharacterAngle, characterList]);

  // Hook for Auto Duration calculation
  useEffect(() => {
    if (!isAutoDuration || isNoSpeech) return;

    // Calculate base speech duration in seconds
    let speechSecs = 0;
    if (audioSourceType === 'tts') {
      const chars = scriptText.replace(/\s+/g, '').length;
      speechSecs = Math.max(1, Math.ceil((chars / 15) / speedFactor));
    } else {
      speechSecs = customAudioDuration || 0;
    }

    // Add 2 seconds padding (+1s at start, +1s at end)
    const targetSecs = speechSecs > 0 ? speechSecs + 2 : 5;

    // Map to valid tiers based on model type
    let finalDuration = 5;
    if (modelType === 'cinema') {
      if (targetSecs <= 5) finalDuration = 5;
      else if (targetSecs <= 10) finalDuration = 10;
      else if (targetSecs <= 15) finalDuration = 15;
      else finalDuration = 25;
    } else if (modelType === 'grok-video') {
      if (targetSecs <= 5) finalDuration = 5;
      else if (targetSecs <= 10) finalDuration = 10;
      else finalDuration = 15;
    } else {
      if (targetSecs <= 5) finalDuration = 5;
      else finalDuration = 10;
    }

    setSelectedDuration(finalDuration);
  }, [isAutoDuration, isNoSpeech, scriptText, audioSourceType, customAudioDuration, modelType, speedFactor]);

  const durationOptions = modelType === 'cinema'
    ? [5, 10, 15, 25]
    : (modelType === 'grok-video' ? [5, 10, 15] : [5, 10]);
  
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

    setCroppingTarget('start');
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

  const handleEndImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
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

    setCroppingTarget('end');
    const reader = new FileReader();
    reader.onload = (ev) => {
      setTempImageSrc(ev.target?.result as string);
      setShowCropper(true);
    };
    reader.readAsDataURL(file);
    if (e.target) {
      e.target.value = '';
    }
  }, []);

  const handleCustomAudioChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('กรุณาเลือกไฟล์เสียงเท่านั้น');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('ขนาดไฟล์เสียงต้องไม่เกิน 15MB');
      return;
    }
    setError(null);
    setCustomAudioFile(file);
    const url = URL.createObjectURL(file);
    setCustomAudioPreview(url);

    // Read audio metadata to get duration
    const audio = new Audio(url);
    audio.addEventListener('loadedmetadata', () => {
      const duration = Math.ceil(audio.duration);
      setCustomAudioDuration(duration);
      console.log(`[Custom Audio] Loaded audio metadata: ${duration}s`);
    });
  }, []);

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
    if (croppingTarget === 'end') {
      setEndImageFile(croppedFile);
      setEndImagePreview(croppedUrl);
    } else {
      setImageFile(croppedFile);
      setImagePreview(croppedUrl);
    }
    setShowCropper(false);
    setTempImageSrc(null);
  }, [croppingTarget]);

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
          setEndImageFile(null);
          setEndImagePreview(null);
          setCustomAudioFile(null);
          setCustomAudioPreview(null);
          setCustomAudioDuration(0);
          setScriptText('');
          setSituationPrompt('');
          setEndSituationPrompt('');
          setSelectedCharacterId('');
          setSpeedFactor(1.0);
          setCharacterEmotion('');
          setCustomEmotionText('');
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
      if (videoMode === 'image_to_video') {
        if (imageFile) {
          formData.append('image', imageFile);
        } else if (selectedCharacterId && imagePreview) {
          formData.append('character_image_url', imagePreview);
        }
      }

      if (modelType === 'motion-control') {
        formData.append('video', videoFile!);
        formData.append('motion_audio_source', motionAudioSource);
        formData.append('script_text', motionAudioSource === 'tts' ? scriptText : '');
      } else {
        formData.append('script_text', isNoSpeech ? '' : scriptText);
      }

      // Character Library Details
      if (selectedCharacterId) {
        const char = characterList.find(c => c.id === selectedCharacterId);
        if (char) {
          formData.append('character_id', char.id);
          formData.append('character_name', char.name);
          formData.append('character_description', char.visual_description);
          if (char.negative_prompt) {
            formData.append('character_negative_prompt', char.negative_prompt);
          }
          if (useLoraModel && char.lora_status === 'completed') {
            formData.append('use_lora_model', 'true');
            formData.append('lora_model_url', char.lora_model_url || '');
            formData.append('lora_trigger_word', char.lora_trigger_word || '');
            formData.append('lora_steps', String(char.lora_steps || 1000));
          }
        }
      }

      // Speech Speed
      formData.append('speed_factor', String(speedFactor));

      // Emotion
      const finalEmotion = characterEmotion === 'custom' ? customEmotionText : characterEmotion;
      if (finalEmotion) {
        formData.append('character_emotion', finalEmotion);
      }
      formData.append('situation_prompt', situationPrompt);
      if (modelType === 'fast') {
        if (endImageFile) {
          formData.append('end_image', endImageFile);
        }
        if (endSituationPrompt.trim()) {
          formData.append('end_situation_prompt', endSituationPrompt);
        }
      }
      formData.append('visual_style', visualStyle);
      formData.append('is_no_speech', String(isNoSpeech));

      if (!isNoSpeech) {
        if (audioSourceType === 'upload' && customAudioFile) {
          formData.append('custom_audio', customAudioFile);
        }
        formData.append('tts_provider', ttsProvider);
        formData.append('voice_id', selectedVoice);
      } else {
        formData.append('tts_provider', 'none');
      }

      formData.append('aspect_ratio', aspectRatio);
      formData.append('user_email', user?.email || 'user@kruth.com');
      formData.append('user_id', user?.id || '');
      formData.append('model_type', modelType);
      formData.append('video_mode', videoMode);
      formData.append('storage_provider', storageProvider);
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
      if (motionAudioSource === 'tts' && !scriptText.trim()) {
        setError('กรุณากรอกบทพากย์สำหรับเสียง AI');
        return;
      }
    } else {
      if (videoMode === 'image_to_video' && !imageFile && (!selectedCharacterId || !imagePreview)) {
        setError('กรุณาอัปโหลดรูปภาพอ้างอิงเริ่มต้น หรือเลือกตัวละครจากคลัง');
        return;
      }
      if (!isNoSpeech) {
        if (audioSourceType === 'tts' && !scriptText.trim()) {
          setError('กรุณากรอกบทพากย์');
          return;
        }
        if (audioSourceType === 'upload' && !customAudioFile) {
          setError('กรุณาอัปโหลดไฟล์เสียงพากย์ของคุณ');
          return;
        }
      }
    }
    if (!isNoSpeech && charCount > maxChars) {
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
        
        {/* User Quota & License Status Card */}
        {whitelistData && (
          <div className="p-4 bg-surface-2/60 border border-white/5 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-md animate-fade-in font-thai">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent-warm animate-pulse" />
                <span className="text-xs font-semibold text-text-muted">สถานะสิทธิ์การใช้งานบัญชีของคุณ</span>
              </div>
              <p className="text-sm font-bold text-text-primary">
                ยินดีต้อนรับคุณ, <span className="text-[#D4AF37]">{whitelistData.display_name || user?.email}</span>
              </p>
              <div className="text-[11px] text-text-muted flex gap-3">
                <span>วันหมดอายุ: {whitelistData.expires_at ? new Date(whitelistData.expires_at).toLocaleDateString('th-TH') : 'ถาวร (Permanent)'}</span>
                {whitelistData.expires_at && (
                  <span className="text-[#D4AF37]">
                    ({(() => {
                      const expiry = new Date(whitelistData.expires_at);
                      const diffMs = expiry.getTime() - Date.now();
                      if (diffMs <= 0) return 'หมดอายุ';
                      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                      return `เหลือเวลาอีกประมาณ ${diffDays} วัน`;
                    })()})
                  </span>
                )}
              </div>
            </div>
            
            <div className="bg-[#1A1A1A] px-4 py-2.5 rounded-xl border border-white/5 flex flex-col items-center justify-center w-full sm:w-auto shadow-inner text-center">
              <span className="text-[10px] text-text-muted font-medium">โควตาสร้างคลิปประจำวันนี้</span>
              <p className="text-base font-bold text-[#D4AF37] font-mono">
                {todaysCount} / {whitelistData.generation_limit || 10}
              </p>
              <span className="text-[10px] text-accent-success">
                (สร้างได้อีก {Math.max(0, (whitelistData.generation_limit || 10) - todaysCount)} คลิป)
              </span>
            </div>
          </div>
        )}

        {/* Generation Mode Selector */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            🎬 รูปแบบการสร้างวิดีโอ (Generation Mode)
          </label>
          <div className="flex bg-gray-100 p-1.5 rounded-xl border border-gray-200">
            <button
              type="button"
              onClick={() => setVideoMode('image_to_video')}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold font-thai transition-all ${
                videoMode === 'image_to_video'
                  ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              🖼️ ภาพเคลื่อนไหว (Image to Video)
            </button>
            <button
              type="button"
              onClick={() => setVideoMode('text_to_video')}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold font-thai transition-all ${
                videoMode === 'text_to_video'
                  ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              ✍️ ข้อความเป็นวิดีโอ (Text to Video)
            </button>
          </div>
        </div>
        
        {/* Admin Model Selector */}
        {isAdmin && (
          <div className="space-y-3 p-3 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-xl mb-4 font-thai">
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
                <option value="hunyuan">🌌 KRUTH Cosmic (Tencent HunyuanVideo)</option>
                {videoMode === 'image_to_video' && (
                  <>
                    <option value="ltx-video">⚡ KRUTH Draft (LTX-Video Quick Draft)</option>
                    <option value="motion-control">🏃 KRUTH Motion (Kling 2.6 Motion Control)</option>
                    <option value="grok-video">🌌 KRUTH Aurora (Grok Imagine Video v1.5)</option>
                  </>
                )}
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

        {/* Visual Style Preset */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            สไตล์ศิลปะวิดีโอ (Visual Style Preset)
          </label>
          <select
            value={visualStyle}
            onChange={(e) => setVisualStyle(e.target.value)}
            className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-gray-800 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai cursor-pointer transition-all"
          >
            <option value="cinematic">🎬 Cinematic (สไตล์ภาพยนตร์ แสงเงาสวยงาม)</option>
            <option value="studio">📸 Studio Portrait (ถ่ายในสตูดิโอ หน้าชัดหลังเบลอพรีเมียม)</option>
            <option value="pixar">🧸 3D Pixar Animation (อนิมิชัน 3 มิติสีสันสดใส)</option>
            <option value="retro">📼 Retro 90s (ภาพกล้องฟิล์มสีย้อนยุค 90)</option>
            <option value="anime">🌸 Japanese Anime (ลายเส้นอนิเมะการ์ตูนญี่ปุ่น)</option>
            <option value="none">⚪ ดั้งเดิม (Original / No Preset)</option>
          </select>
        </div>

        {/* Character/Scene Emotion Selector */}
        <div className="space-y-2 animate-fade-in">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            🎭 อารมณ์ของตัวละครหรือฉาก (Character/Scene Emotion)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={characterEmotion}
              onChange={(e) => {
                setCharacterEmotion(e.target.value);
                if (e.target.value !== 'custom') {
                  setCustomEmotionText('');
                }
              }}
              className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-gray-800 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai cursor-pointer transition-all"
            >
              <option value="">⚪ ไม่ระบุอารมณ์ (ตามปกติ)</option>
              <option value="Friendly & Smiling">😊 Friendly & Smiling (ยิ้มแย้ม เป็นกันเอง)</option>
              <option value="Professional & Serious">💼 Professional & Serious (สุขุม จริงจัง มืออาชีพ)</option>
              <option value="Energetic & Excited">⚡ Energetic & Excited (กระตือรือร้น ตื่นเต้น มีพลัง)</option>
              <option value="Empathetic & Gentle">🤝 Empathetic & Gentle (อ่อนโยน เห็นอกเห็นใจ)</option>
              <option value="Fearful & Worried">😨 Fearful & Worried (กังวล กลัว)</option>
              <option value="Sad & Gloomy">😢 Sad & Gloomy (เศร้า หมองหม่น)</option>
              <option value="custom">✍️ กำหนดเอง (พิมพ์อารมณ์เอง)</option>
            </select>

            {characterEmotion === 'custom' && (
              <input
                type="text"
                required
                value={customEmotionText}
                onChange={(e) => setCustomEmotionText(e.target.value)}
                placeholder="เช่น warm smile, looking serious, intense look"
                className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-gray-800 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai animate-fade-in"
              />
            )}
          </div>
        </div>

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

        {/* Character Library Selector */}
        <div className="space-y-3 p-4 bg-gray-50 border border-gray-200 rounded-2xl animate-fade-in">
          <label className="block text-sm font-medium text-text-secondary font-thai">
            👤 เลือกตัวละครจากคลัง (Character Library)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <select
              value={selectedCharacterId}
              onChange={(e) => {
                setSelectedCharacterId(e.target.value);
                if (!e.target.value) {
                  setImagePreview(null);
                  setImageFile(null);
                }
              }}
              className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-gray-800 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai cursor-pointer transition-all"
            >
              <option value="">⚪ ไม่ใช้ตัวละคร (อัปโหลดรูปภาพอิสระเอง)</option>
              {characterList.map((char) => (
                <option key={char.id} value={char.id}>
                  👤 {char.name} ({char.code})
                </option>
              ))}
            </select>

            {selectedCharacterId && videoMode === 'image_to_video' && (
              <select
                value={selectedCharacterAngle}
                onChange={(e) => setSelectedCharacterAngle(e.target.value as any)}
                className="w-full bg-white border border-gray-200 p-3 rounded-xl text-sm text-[#D4AF37] font-bold outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai cursor-pointer transition-all animate-fade-in"
              >
                <option value="front">👤 ภาพหน้าตรง (Front View)</option>
                <option value="45">📐 ภาพมุม 45 องศา (45° View)</option>
                <option value="side">👥 ภาพมุมข้าง (Side View)</option>
              </select>
            )}

            {selectedCharacterId && videoMode === 'image_to_video' && characterList.find(c => c.id === selectedCharacterId)?.lora_status === 'completed' && (
              <div className="flex items-center gap-2.5 p-3.5 bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-xl animate-fade-in">
                <input
                  type="checkbox"
                  id="useLoraModel"
                  checked={useLoraModel}
                  onChange={(e) => setUseLoraModel(e.target.checked)}
                  className="rounded border-gray-300 text-[#D4AF37] focus:ring-[#D4AF37] h-4.5 w-4.5 cursor-pointer"
                />
                <label htmlFor="useLoraModel" className="text-xs text-text-secondary font-thai font-medium cursor-pointer select-none flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
                  เปิดใช้งานโมเดล AI ล็อคใบหน้าตัวละคร (Use LoRA Model)
                </label>
              </div>
            )}
          </div>
          {selectedCharacterId && (
            <div className="text-xs text-text-secondary font-thai bg-white p-3 rounded-xl border border-gray-200 animate-fade-in space-y-1">
              <span className="font-bold text-gray-700">รายละเอียดตัวละคร:</span>
              <p className="italic">"{characterList.find(c => c.id === selectedCharacterId)?.visual_description}"</p>
              {characterList.find(c => c.id === selectedCharacterId)?.negative_prompt && (
                <p className="text-[#D4AF37] mt-1">
                  <span className="font-bold">สิ่งที่เลี่ยง:</span> {characterList.find(c => c.id === selectedCharacterId)?.negative_prompt}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Image Upload */}
        {videoMode === 'image_to_video' && (
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
                  {useLoraModel && (
                    <div className="absolute top-2 left-2 px-2.5 py-1 bg-[#D4AF37] text-white text-[10px] font-bold rounded-lg flex items-center gap-1 shadow font-thai animate-pulse">
                      <Sparkles className="w-3 h-3" />
                      ใช้โมเดล AI ล็อคใบหน้า (LoRA)
                    </div>
                  )}
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
        )}

        {/* End Frame Settings (Kling 2.5 only) */}
        {videoMode === 'image_to_video' && modelType === 'fast' && (
          <div className="space-y-4 p-4 bg-gray-50 border border-gray-200 rounded-2xl animate-fade-in">
            <h3 className="text-sm font-semibold text-gray-800 font-thai border-b border-gray-200 pb-2 flex items-center gap-2">
              🎬 ตั้งค่าเฟรมท้าย (End Frame Morphing Settings)
            </h3>
            
            {/* End Image Upload */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-text-secondary font-thai">
                รูปภาพเฟรมท้าย (End Frame Image)
              </label>
              <div
                onClick={() => endFileInputRef.current?.click()}
                className={`relative group cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden ${
                  endImagePreview
                    ? 'border-accent-primary/30 bg-white'
                    : 'border-gray-300 hover:border-[#D4AF37] bg-white'
                }`}
              >
                {endImagePreview ? (
                  <div className="relative">
                    <img src={endImagePreview} alt="End Frame Preview" className={getPreviewAspectClass()} />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <p className="text-white text-sm font-medium font-thai">คลิกเพื่อเปลี่ยนรูปเฟรมท้าย</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEndImageFile(null);
                        setEndImagePreview(null);
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-6 px-4">
                    <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center mb-2 group-hover:bg-[#D4AF37]/10 transition-colors">
                      <ImagePlus className="w-5 h-5 text-gray-500 group-hover:text-[#D4AF37]" />
                    </div>
                    <p className="text-xs font-medium text-gray-700 mb-0.5 font-thai">
                      คลิกเพื่ออัปโหลดรูปภาพเฟรมท้าย
                    </p>
                    <p className="text-[10px] text-gray-400 font-thai">
                      รองรับ JPG, PNG, WebP (สูงสุด 10MB)
                    </p>
                  </div>
                )}
              </div>
              <input ref={endFileInputRef} type="file" accept="image/*" onChange={handleEndImageChange} className="hidden" />
            </div>

            {/* End Situation Prompt */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-text-secondary font-thai">
                สภาวะภาพตอนท้าย (End Situation Prompt)
              </label>
              <input
                type="text"
                value={endSituationPrompt}
                onChange={(e) => setEndSituationPrompt(e.target.value)}
                placeholder="เช่น looking straight, warm smile, neutral pose"
                className="w-full bg-white border border-gray-200 p-2.5 rounded-xl text-xs text-gray-800 placeholder-gray-400 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] font-thai transition-all"
              />
            </div>
          </div>
        )}

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
                    คลิกเพื่ออัปโหลดวิดีโออ้างอิงเริ่มต้น
                  </p>
                  <p className="text-xs text-gray-400 font-thai">
                    รองรับ MP4 (สูงสุด 20MB)
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
                onClick={() => setMotionAudioSource('tts')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                  motionAudioSource === 'tts'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🤖 เสียงพากย์ AI (TTS Voice)
              </button>
            </div>
          </div>
        )}

        {/* No-Speech Mode Checkbox */}
        {(!isMotionControl) && (
          <div className="flex items-center justify-between p-3.5 bg-gray-50 border border-gray-200 rounded-xl">
            <span className="text-sm font-medium text-gray-700 font-thai">🎬 โหมดไม่มีเสียงพากย์ (No-Speech / B-Roll Mode)</span>
            <button
              type="button"
              onClick={() => {
                const nextNoSpeech = !isNoSpeech;
                setIsNoSpeech(nextNoSpeech);
                if (nextNoSpeech) {
                  setIsAutoDuration(false);
                } else {
                  setIsAutoDuration(true);
                }
              }}
              className={`px-3 py-1 rounded-lg font-thai font-bold text-xs transition-all ${
                isNoSpeech
                  ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-sm'
                  : 'bg-white text-gray-600 border border-gray-300 hover:border-gray-400'
              }`}
            >
              {isNoSpeech ? '🔴 ปิดเสียงพากย์ (No-Speech On)' : '⚪ ใช้เสียงพากย์ (No-Speech Off)'}
            </button>
          </div>
        )}

        {/* Audio Source Type Toggle */}
        {!isNoSpeech && (!isMotionControl || (isMotionControl && motionAudioSource === 'tts')) && (
          <div className="space-y-2 p-3 bg-gray-50 border border-gray-200 rounded-xl">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider font-thai">
              การจัดเตรียมเสียงพากย์ (Voice Source Type)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAudioSourceType('tts')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                  audioSourceType === 'tts'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🤖 เสียงสังเคราะห์ AI (TTS)
              </button>
              <button
                type="button"
                onClick={() => setAudioSourceType('upload')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                  audioSourceType === 'upload'
                    ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                    : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                }`}
              >
                🎙️ อัปโหลดไฟล์เสียงเอง (Custom)
              </button>
            </div>
          </div>
        )}

        {/* Custom Audio Upload Field */}
        {!isNoSpeech && (!isMotionControl || (isMotionControl && motionAudioSource === 'tts')) && audioSourceType === 'upload' && (
          <div className="space-y-2 animate-fade-in">
            <label className="block text-sm font-medium text-text-secondary font-thai">
              🎙️ ไฟล์เสียงพากย์ของคุณ (Custom Audio File)
            </label>
            <div
              onClick={() => customAudioInputRef.current?.click()}
              className={`relative group cursor-pointer p-6 rounded-xl border-2 border-dashed transition-all duration-200 text-center ${
                customAudioPreview
                  ? 'border-accent-primary/30 bg-white'
                  : 'border-gray-300 hover:border-[#D4AF37] bg-white'
              }`}
            >
              {customAudioFile ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700 font-thai">
                    🎵 {customAudioFile.name}
                  </p>
                  <p className="text-xs text-gray-400 font-thai">
                    ความยาวเสียง: {customAudioDuration} วินาที (ขนาด {(customAudioFile.size / (1024 * 1024)).toFixed(2)}MB)
                  </p>
                  <audio src={customAudioPreview || undefined} controls className="mx-auto max-w-full" onClick={(e) => e.stopPropagation()} />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCustomAudioFile(null);
                      setCustomAudioPreview(null);
                      setCustomAudioDuration(0);
                    }}
                    className="mt-2 text-xs text-accent-danger font-bold hover:underline"
                  >
                    ลบไฟล์เสียง
                  </button>
                </div>
              ) : (
                <div className="py-4">
                  <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2 group-hover:text-[#D4AF37]" />
                  <p className="text-xs font-medium text-gray-700 font-thai">
                    คลิกเพื่ออัปโหลดไฟล์เสียงพากย์ของคุณ
                  </p>
                  <p className="text-[10px] text-gray-400 font-thai mt-0.5">
                    รองรับ MP3, WAV, M4A (สูงสุด 15MB)
                  </p>
                </div>
              )}
            </div>
            <input
              ref={customAudioInputRef}
              type="file"
              accept="audio/*"
              onChange={handleCustomAudioChange}
              className="hidden"
            />
          </div>
        )}

        {/* Script Text */}
        {!isNoSpeech && (!isMotionControl || (isMotionControl && motionAudioSource === 'tts')) && audioSourceType === 'tts' && (
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

        {/* Storage & TTS Option Switches */}
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

          {/* TTS Provider Option */}
          {!isNoSpeech && audioSourceType === 'tts' && (
            <div className="space-y-2 border-t border-gray-200 pt-3">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider font-thai">
                ผู้ให้บริการเสียงพากย์ (TTS Provider)
              </label>
              <div className="flex gap-2 max-w-md">
                <button
                  type="button"
                  onClick={() => {
                    setTtsProvider('google');
                    setSelectedVoice('th-TH-Neural2-C');
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    ttsProvider === 'google'
                      ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                      : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                  }`}
                >
                  🌐 Google
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTtsProvider('openai');
                    setSelectedVoice('nova');
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    ttsProvider === 'openai'
                      ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                      : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                  }`}
                >
                  🧠 OpenAI
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTtsProvider('cosyvoice');
                    setSelectedVoice('FunAudioLLM/CosyVoice2-0.5B:anna');
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    ttsProvider === 'cosyvoice'
                      ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                      : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                  }`}
                >
                  🎙️ CosyVoice
                </button>
              </div>
            </div>
          )}

          {/* Speech Speed Option */}
          {!isNoSpeech && audioSourceType === 'tts' && (
            <div className="space-y-2 border-t border-gray-200 pt-3 animate-fade-in">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider font-thai">
                📈 ความเร็วในการพูด (Speech Speed)
              </label>
              <div className="flex gap-2 max-w-md">
                {[
                  { value: 0.8, label: 'ช้า (0.8x)' },
                  { value: 1.0, label: 'ปกติ (1.0x)' },
                  { value: 1.2, label: 'เร็วขึ้น (1.2x)' },
                  { value: 1.5, label: 'เร็ว (1.5x)' }
                ].map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setSpeedFactor(item.value)}
                    className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${
                      speedFactor === item.value
                        ? 'bg-[#1A1A1A] text-[#D4AF37] border border-[#D4AF37] shadow-sm'
                        : 'bg-white text-gray-800 border border-gray-200 hover:border-[#1A1A1A]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Voice Selection */}
        {!isNoSpeech && audioSourceType === 'tts' && (!isMotionControl || (isMotionControl && motionAudioSource === 'tts')) && (
          <VoicePreview selectedVoice={selectedVoice} onSelect={setSelectedVoice} ttsProvider={ttsProvider} />
        )}

        {/* Video Duration */}
        {!isMotionControl && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-text-secondary font-thai">
                ความยาววิดีโอ (Video Duration)
              </label>
              
              {!isNoSpeech && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isAutoDuration}
                    onChange={(e) => setIsAutoDuration(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="relative w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#D4AF37]"></div>
                  <span className="text-xs font-semibold text-gray-600 font-thai">อัตโนมัติ (Auto)</span>
                </label>
              )}
            </div>

            {isAutoDuration && !isNoSpeech ? (
              <div className="p-3.5 bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-xl flex items-center justify-between text-[#D4AF37] font-thai text-sm animate-fade-in">
                <span>⏱️ คำนวณความยาวอัตโนมัติสำเร็จ</span>
                <span className="font-bold text-base bg-[#1A1A1A] px-3 py-1 rounded-lg border border-[#D4AF37] shadow-sm">
                  {selectedDuration} วินาที
                </span>
              </div>
            ) : (
              <div className="flex gap-2 animate-fade-in">
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
            )}
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={
            processing ||
            (!imageFile && !selectedCharacterId) ||
            (modelType === 'motion-control' && !videoFile) ||
            (modelType !== 'motion-control' && !isNoSpeech && audioSourceType === 'tts' && !scriptText.trim()) ||
            (modelType !== 'motion-control' && !isNoSpeech && audioSourceType === 'upload' && !customAudioFile) ||
            (modelType === 'motion-control' && motionAudioSource === 'tts' && !scriptText.trim())
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
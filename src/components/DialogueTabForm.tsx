'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Volume2,
  VolumeX,
  Play,
  Film,
  Sparkles,
  Loader2,
  AlertCircle,
  Video,
  CheckCircle2,
  HelpCircle
} from 'lucide-react';
import { THAI_VOICES, ASPECT_RATIOS } from '@/types';
import { useAuth } from '@/lib/auth-context';
import { getCharacters, supabase } from '@/lib/supabase-db';
import DialogueCanvasWorkspace, { type FaceTag } from './DialogueCanvasWorkspace';

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
  lora_model_url?: string;
  lora_trigger_word?: string;
}
interface DialogueCardData {
  id: string;
  characterId: string;
  voiceId: string;
  scriptText: string;
  speedFactor: number;
  emotion: 'normal' | 'shocked' | 'happy' | 'sad' | 'angry' | 'custom';
  customEmotionText: string;
  status: 'idle' | 'generating' | 'polling' | 'completed' | 'failed';
  progressPercent?: number;
  progressMessage?: string;
  videoUrl?: string;
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
}

const cropFaceImage = async (
  imgUrl: string,
  tag: FaceTag
): Promise<{ file: File; cropX: number; cropY: number; cropW: number; cropH: number }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Avoid CORS tainted canvas issues
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('ไม่สามารถสร้าง Context ของ Canvas ได้'));
          return;
        }
        
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;

        // Golden Ratio layout: Expand box to capture head & shoulders naturally
        const marginX = tag.boxWidth * 0.50; // expand 50% left/right
        const marginYTop = tag.boxHeight * 0.40; // expand 40% up
        const marginYBottom = tag.boxHeight * 1.20; // expand 120% down for neck/shoulders

        const relativeX = Math.max(0, tag.boxX - marginX);
        const relativeY = Math.max(0, tag.boxY - marginYTop);
        const relativeW = Math.min(1 - relativeX, tag.boxWidth + 2 * marginX);
        const relativeH = Math.min(1 - relativeY, tag.boxHeight + marginYTop + marginYBottom);

        // Absolute pixel dimensions
        const sourceX = Math.round(relativeX * imgW);
        const sourceY = Math.round(relativeY * imgH);
        const sourceWidth = Math.round(relativeW * imgW);
        const sourceHeight = Math.round(relativeH * imgH);

        canvas.width = sourceWidth;
        canvas.height = sourceHeight;

        // Draw cropped section
        ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('การประมวลผลครอปรูปภาพล้มเหลว'));
            return;
          }
          const file = new File([blob], `cropped_${tag.characterId}.png`, { type: 'image/png' });
          resolve({
            file,
            cropX: relativeX,
            cropY: relativeY,
            cropW: relativeW,
            cropH: relativeH
          });
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('ดาวน์โหลดรูปฉากหลังเพื่อครอปไม่สำเร็จ'));
    img.src = imgUrl;
  });
};

export default function DialogueTabForm() {
  const { user } = useAuth();
  
  // Project settings
  const [projectTitle, setProjectTitle] = useState('บทสนทนาของฉัน');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [ttsProvider, setTtsProvider] = useState<'google' | 'openai' | 'cosyvoice'>('google');
  
  // List of characters from DB
  const [characterList, setCharacterList] = useState<Character[]>([]);
  const [loadingCharacters, setLoadingCharacters] = useState(true);

  // Cards timeline state
  const [cards, setCards] = useState<DialogueCardData[]>([
    {
      id: 'initial-1',
      characterId: '',
      voiceId: '',
      scriptText: '',
      speedFactor: 1.0,
      emotion: 'normal',
      customEmotionText: '',
      status: 'idle'
    }
  ]);

  // Overall batch state
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [currentGeneratingIndex, setCurrentGeneratingIndex] = useState<number | null>(null);

  // Merging state
  const [merging, setMerging] = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Audio preview helper
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Base Scene Image & Face tagging states
  const [baseImageFile, setBaseImageFile] = useState<File | null>(null);
  const [baseImagePreview, setBaseImagePreview] = useState<string | null>(null);
  const [faceTags, setFaceTags] = useState<FaceTag[]>([]);

  const handleBaseImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBaseImageFile(file);
    setBaseImagePreview(URL.createObjectURL(file));
    setFaceTags([]); // Clear previous tags when changing base image
  };

  const clearBaseImage = () => {
    setBaseImageFile(null);
    if (baseImagePreview) {
      URL.revokeObjectURL(baseImagePreview);
    }
    setBaseImagePreview(null);
    setFaceTags([]);
  };

  // Load characters on mount
  useEffect(() => {
    if (user?.email) {
      setLoadingCharacters(true);
      getCharacters(user.email)
        .then((data) => {
          setCharacterList(data);
          // Auto-select first character for initial card if available
          if (data.length > 0) {
            setCards((prev) =>
              prev.map((c) => (c.characterId === '' ? { ...c, characterId: data[0].id } : c))
            );
          }
        })
        .catch((err) => {
          console.error('[DialogueForm] Failed to load characters:', err);
        })
        .finally(() => {
          setLoadingCharacters(false);
        });
    }
  }, [user?.email]);

  // Handle setting default voice when ttsProvider changes
  useEffect(() => {
    const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
    if (providerVoices.length > 0) {
      const defaultVoice = providerVoices[0].id;
      setCards((prev) =>
        prev.map((c) => {
          // If the current voice is not in the new provider's list, reset it
          const voiceExists = providerVoices.some((v) => v.id === c.voiceId);
          return voiceExists ? c : { ...c, voiceId: defaultVoice };
        })
      );
    }
  }, [ttsProvider]);

  // Helper to parse avatar URL
  const getAvatarUrl = (char: Character | undefined): string => {
    if (!char) return '';
    const parseFirstUrl = (val: string | undefined | null): string => {
      if (!val) return '';
      if (val.startsWith('[') && val.endsWith(']')) {
        try {
          const arr = JSON.parse(val);
          return Array.isArray(arr) && arr.length > 0 ? arr[0] : '';
        } catch {
          return val;
        }
      }
      return val;
    };
    return parseFirstUrl(char.avatar_front_url);
  };

  // Update specific card field
  const updateCard = (id: string, updates: Partial<DialogueCardData>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  // Add card
  const addCard = () => {
    const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
    const defaultVoice = providerVoices.length > 0 ? providerVoices[0].id : '';
    const defaultCharId = characterList.length > 0 ? characterList[0].id : '';

    setCards((prev) => [
      ...prev,
      {
        id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        characterId: defaultCharId,
        voiceId: defaultVoice,
        scriptText: '',
        speedFactor: 1.0,
        emotion: 'normal',
        customEmotionText: '',
        status: 'idle'
      }
    ]);
  };

  // Delete card
  const deleteCard = (id: string) => {
    if (cards.length === 1) return; // Must have at least 1 card
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  // Move card up
  const moveCardUp = (index: number) => {
    if (index === 0) return;
    setCards((prev) => {
      const list = [...prev];
      const temp = list[index];
      list[index] = list[index - 1];
      list[index - 1] = temp;
      return list;
    });
  };

  // Move card down
  const moveCardDown = (index: number) => {
    if (index === cards.length - 1) return;
    setCards((prev) => {
      const list = [...prev];
      const temp = list[index];
      list[index] = list[index + 1];
      list[index + 1] = temp;
      return list;
    });
  };

  // Preview TTS voice
  const handleVoicePreview = (voiceId: string) => {
    const voice = THAI_VOICES.find((v) => v.id === voiceId);
    if (!voice) return;

    if (playingVoice === voiceId) {
      audioRef.current?.pause();
      setPlayingVoice(null);
      return;
    }

    try {
      setPlayingVoice(voiceId);
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(voice.sample_url);
      audioRef.current = audio;
      audio.onended = () => setPlayingVoice(null);
      audio.onerror = () => setPlayingVoice(null);
      audio.play().catch(() => setPlayingVoice(null));
    } catch {
      setPlayingVoice(null);
    }
  };

  // Recursive status poller for single card
  const pollCardStatus = async (
    cardId: string,
    requestId: string,
    videoPath: string
  ): Promise<string> => {
    try {
      const statusRes = await fetch('/api/video-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          videoPath,
          modelType: 'fast',
          storageProvider: 'supabase'
        })
      });

      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        const url = statusData.videoUrl;
        updateCard(cardId, {
          status: 'completed',
          progressPercent: 100,
          progressMessage: '✅ เสร็จสมบูรณ์!',
          videoUrl: url
        });
        return url;
      } else if (statusData.status === 'FAILED' || statusData.status === 'ERROR') {
        const errMsg = statusData.error || 'การสร้างวิดีโอล้มเหลว';
        updateCard(cardId, {
          status: 'failed',
          progressPercent: undefined,
          progressMessage: `❌ ล้มเหลว: ${errMsg}`
        });
        throw new Error(errMsg);
      } else {
        const progressMessage = statusData.progressMessage || 'กำลังประมวลผล...';
        const progressPercent = statusData.progressPercent !== undefined ? statusData.progressPercent : 50;

        updateCard(cardId, {
          status: 'polling',
          progressPercent,
          progressMessage
        });

        // Wait 8 seconds before next poll
        await new Promise((resolve) => setTimeout(resolve, 8000));
        return await pollCardStatus(cardId, requestId, videoPath);
      }
    } catch (err: any) {
      const errMsg = err.message || 'เกิดข้อผิดพลาดในการดึงสถานะ';
      updateCard(cardId, {
        status: 'failed',
        progressPercent: undefined,
        progressMessage: `❌ ข้อผิดพลาด: ${errMsg}`
      });
      throw err;
    }
  };

  // Generate video for a single card
  const generateCardVideo = async (cardId: string): Promise<string> => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new Error('ไม่พบข้อมูลบทสนทนา');

    const char = characterList.find((c) => c.id === card.characterId);
    if (!char) {
      throw new Error('กรุณาเลือกตัวละครก่อนเริ่มสร้าง');
    }
    if (!card.scriptText.trim()) {
      throw new Error('กรุณาพิมพ์บทพูดของตัวละคร');
    }

    updateCard(cardId, {
      status: 'generating',
      progressPercent: 5,
      progressMessage: 'กำลังอัปโหลดข้อมูลคำขอ...'
    });

    let cropX: number | undefined;
    let cropY: number | undefined;
    let cropW: number | undefined;
    let cropH: number | undefined;

    try {
      const formData = new FormData();
      
      // Check if character is linked to a face on base image
      const linkedTag = faceTags.find(t => t.characterId === card.characterId);
      if (baseImagePreview && linkedTag) {
        updateCard(cardId, {
          status: 'generating',
          progressMessage: 'กำลังครอปรูปภาพใบหน้า...'
        });
        const croppedResult = await cropFaceImage(baseImagePreview, linkedTag);
        formData.append('image', croppedResult.file);
        
        cropX = croppedResult.cropX;
        cropY = croppedResult.cropY;
        cropW = croppedResult.cropW;
        cropH = croppedResult.cropH;
        
        updateCard(cardId, {
          cropX,
          cropY,
          cropW,
          cropH
        });
        console.log(`[DialogueForm] Cropped face for card:`, cropX, cropY, cropW, cropH);
      } else {
        // Starting avatar image fallback
        const avatarUrl = getAvatarUrl(char);
        if (avatarUrl) {
          formData.append('character_image_url', avatarUrl);
        }
        
        updateCard(cardId, {
          cropX: undefined,
          cropY: undefined,
          cropW: undefined,
          cropH: undefined
        });
      }

      formData.append('script_text', card.scriptText);
      formData.append('character_id', char.id);
      formData.append('character_name', char.name);
      formData.append('character_description', char.visual_description);
      
      if (char.negative_prompt) {
        formData.append('character_negative_prompt', char.negative_prompt);
      }

      // LoRA integration if trained
      if (char.lora_status === 'completed') {
        formData.append('use_lora_model', 'true');
        formData.append('lora_model_url', char.lora_model_url || '');
        formData.append('lora_trigger_word', char.lora_trigger_word || '');
      }

      formData.append('speed_factor', String(card.speedFactor));
      
      const finalEmotion = card.emotion === 'custom' ? card.customEmotionText : card.emotion;
      if (finalEmotion && finalEmotion !== 'normal') {
        formData.append('character_emotion', finalEmotion);
      }

      formData.append('visual_style', 'cinematic');
      formData.append('is_no_speech', 'false');
      formData.append('tts_provider', ttsProvider);
      formData.append('voice_id', card.voiceId);
      formData.append('aspect_ratio', aspectRatio);
      formData.append('user_email', user?.email || '');
      formData.append('user_id', user?.id || '');
      formData.append('model_type', 'fast');
      formData.append('video_mode', 'image_to_video');
      formData.append('storage_provider', 'supabase');

      // Calculate script duration (15 chars = 1 sec)
      const cleanChars = card.scriptText.replace(/\s+/g, '').length;
      const speechDuration = Math.max(1, Math.ceil((cleanChars / 15) / card.speedFactor));
      // Buffer of +2s (1s front/back)
      const targetDuration = speechDuration + 2;
      const finalDuration = targetDuration <= 5 ? 5 : 10;
      formData.append('duration', String(finalDuration));

      const generateRes = await fetch('/api/generate-video', {
        method: 'POST',
        body: formData
      });

      const generateData = await generateRes.json();
      if (!generateData.success) {
        throw new Error(generateData.error || 'เซิร์ฟเวอร์ปฏิเสธการขอสร้างวิดีโอ');
      }

      updateCard(cardId, {
        status: 'polling',
        progressPercent: 15,
        progressMessage: '⏳ กำลังรอจัดคิวโดย KRUTH Engine...'
      });

      const completedVideoUrl = await pollCardStatus(cardId, generateData.requestId, generateData.videoPath);
      return completedVideoUrl;
    } catch (err: any) {
      const errMsg = err.message || 'เกิดข้อผิดพลาดในการเจนวิดีโอ';
      updateCard(cardId, {
        status: 'failed',
        progressPercent: undefined,
        progressMessage: `❌ ล้มเหลว: ${errMsg}`
      });
      throw err;
    }
  };

  // Generate all uncompleted clips in sequence
  const generateAllClips = async () => {
    if (batchGenerating) return;
    setBatchGenerating(true);
    setMergeError(null);

    try {
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (card.status === 'completed' && card.videoUrl) {
          continue; // Skip already generated clips
        }

        setCurrentGeneratingIndex(i);
        await generateCardVideo(card.id);
      }
    } catch (err: any) {
      console.error('[Batch Generation Error]', err);
      setMergeError('การสร้างคลิปใน Timeline หยุดชะงักลงเนื่องจากมีบางการ์ดเกิดข้อผิดพลาด');
    } finally {
      setBatchGenerating(false);
      setCurrentGeneratingIndex(null);
    }
  };

  // Merge finished clips together
  const mergeFinalVideo = async () => {
    // Validate that all cards are generated
    const hasUncompleted = cards.some((c) => !c.videoUrl || c.status !== 'completed');
    if (hasUncompleted) {
      setMergeError('ไม่สามารถรวมวิดีโอได้: กรุณาสร้างคลิปย่อยของการ์ดบทสนทนาทุกใบให้เสร็จก่อน');
      return;
    }

    if (cards.length < 2) {
      setMergeError('ไม่สามารถรวมวิดีโอได้: กรุณาเพิ่มบทสนทนาอย่างน้อย 2 ประโยคขึ้นไป');
      return;
    }

    setMerging(true);
    setMergeError(null);
    setMergedVideoUrl(null);

    const videoClips = cards.map((c) => ({
      videoUrl: c.videoUrl as string,
      cropX: c.cropX ?? null,
      cropY: c.cropY ?? null,
      cropW: c.cropW ?? null,
      cropH: c.cropH ?? null
    }));

    try {
      // 1. Upload base image to Supabase if present
      let uploadedBaseImageUrl = '';
      if (baseImageFile && supabase) {
        setMergeError('กำลังอัปโหลดรูปภาพฉากหลัง...');
        const timestamp = Date.now();
        const fileExt = baseImageFile.name.split('.').pop() || 'png';
        const storagePath = `dialogue_bases/${user?.email || 'unknown'}/${timestamp}_base.${fileExt}`;

        const { data, error: uploadError } = await supabase.storage
          .from('kruth-ai-assets')
          .upload(storagePath, baseImageFile, {
            upsert: true
          });

        if (uploadError) {
          throw new Error(`อัปโหลดรูปภาพฉากหลังล้มเหลว: ${uploadError.message}`);
        }

        // Get public URL
        const { data: { publicUrl } } = supabase.storage
          .from('kruth-ai-assets')
          .getPublicUrl(storagePath);
        uploadedBaseImageUrl = publicUrl;
      }

      setMergeError(null);

      // 2. Call merge API with videoClips, baseImageUrl and faceTags metadata
      const response = await fetch('/api/merge-dialogue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: projectTitle,
          videoClips,
          user_email: user?.email || '',
          user_id: user?.id || '',
          aspectRatio,
          baseImageUrl: uploadedBaseImageUrl || null,
          faceTags: faceTags.length > 0 ? faceTags : null
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'เกิดข้อผิดพลาดทางเทคนิคในการรวมคลิป');
      }

      setMergedVideoUrl(result.videoUrl);
      // Scroll to video output smooth
      setTimeout(() => {
        const el = document.getElementById('merged-video-result');
        el?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch (err: any) {
      console.error('[Merge Video Error]', err);
      setMergeError(err.message || 'รวมวิดีโอล้มเหลว');
    } finally {
      setMerging(false);
    }
  };

  // Check if we can enable the merge button
  const canMerge = cards.length >= 2 && cards.every((c) => c.status === 'completed' && c.videoUrl);

  return (
    <div className="space-y-8">
      {/* Global Config Section */}
      <div className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#D4AF37]" /> การตั้งค่าโปรเจกต์บทสนทนา
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Project Title */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-2 font-thai">
              ชื่อเรื่องโปรเจกต์
            </label>
            <input
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai"
              placeholder="เช่น การพูดคุยของครูสมศรีกับสมชาย"
            />
          </div>

          {/* Aspect Ratio */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-2 font-thai">
              อัตราส่วนหน้าจอ (Aspect Ratio)
            </label>
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
            >
              {ASPECT_RATIOS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.icon} {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* TTS Provider */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-2 font-thai">
              ผู้ให้บริการเสียงสังเคราะห์ (TTS Provider)
            </label>
            <select
              value={ttsProvider}
              onChange={(e) => setTtsProvider(e.target.value as any)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
            >
              <option value="google">🌐 Google Cloud Neural2</option>
              <option value="openai">🧠 OpenAI Speech</option>
              <option value="cosyvoice">🔥 SiliconFlow CosyVoice2</option>
            </select>
          </div>
        </div>
      </div>

      {/* Background Image Upload & Face Tagging Section */}
      <div className="bg-[#FAF8F5] border border-gray-100 p-6 rounded-2xl space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 font-thai flex items-center gap-2">
          <Film className="w-4 h-4 text-[#D4AF37]" /> ฉากหลังตัวละครหลักและการติดแท็กใบหน้า (Base Scene & Face Tagging - ทางเลือก)
        </h3>
        
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
            {/* File Input */}
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-600 mb-2 font-thai">
                ภาพฉากหลังกลุ่มหลัก (สำหรับติดแท็กใบหน้าเพื่อให้ตัวละครพูดอยู่ร่วมเฟรมเดียวกัน)
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={handleBaseImageChange}
                className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#1A1A1A] file:text-[#D4AF37] hover:file:opacity-90 font-thai cursor-pointer"
              />
            </div>
            
            {/* Reset Button */}
            {baseImagePreview && (
              <button
                type="button"
                onClick={clearBaseImage}
                className="mt-6 text-xs text-red-500 hover:text-red-700 font-thai font-semibold border border-red-200 px-4 py-2 rounded-xl hover:bg-red-50 transition-all flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" /> ล้างรูปภาพและแท็ก
              </button>
            )}
          </div>
          
          {/* Canvas Workspace Component */}
          {baseImagePreview && characterList.length > 0 && (
            <div className="bg-white border border-gray-150 rounded-2xl p-4 shadow-inner">
              <DialogueCanvasWorkspace
                imageUrl={baseImagePreview}
                characters={characterList}
                faceTags={faceTags}
                onTagsChange={setFaceTags}
              />
            </div>
          )}
        </div>
      </div>

      {/* Loading characters state */}
      {loadingCharacters ? (
        <div className="flex flex-col items-center py-12">
          <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin mb-2" />
          <p className="text-sm text-gray-500 font-thai">กำลังดึงข้อมูลคลังตัวละครของท่าน...</p>
        </div>
      ) : characterList.length === 0 ? (
        <div className="flex flex-col items-center py-12 bg-yellow-50/50 border border-dashed border-yellow-200 rounded-3xl text-center px-6">
          <AlertCircle className="w-12 h-12 text-yellow-500 mb-4" />
          <h4 className="text-lg font-medium text-gray-800 font-thai mb-2">ไม่พบโมเดลตัวละครในคลัง</h4>
          <p className="text-sm text-gray-500 font-thai max-w-md mb-6 leading-relaxed">
            ระบบสร้างคลิปบทสนทนาต้องการโมเดลตัวละครที่เทรนเสร็จแล้วเพื่อเป็นใบหน้าต้นแบบ กรุณาไปที่ระบบ <strong>"คลังตัวละคร"</strong> เพื่อเพิ่มและเทรนตัวละครก่อนเริ่มสร้างคลิป
          </p>
          <a
            href="/characters"
            className="px-6 py-2.5 bg-[#1A1A1A] text-[#D4AF37] font-semibold text-sm rounded-xl hover:bg-black transition-all font-thai"
          >
            ไปหน้าคลังตัวละคร
          </a>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Vertical Timeline wrapper */}
          <div className="relative pl-6 sm:pl-10 space-y-8 before:absolute before:left-3 sm:before:left-5 before:top-2 before:bottom-2 before:w-0.5 before:bg-gradient-to-b before:from-[#D4AF37] before:to-gray-200">
            {cards.map((card, index) => {
              const char = characterList.find((c) => c.id === card.characterId);
              const avatar = getAvatarUrl(char);
              const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
              
              // Resolve default voice value if none selected
              const activeVoiceId = card.voiceId || (providerVoices.length > 0 ? providerVoices[0].id : '');

              return (
                <div
                  key={card.id}
                  className="relative group transition-all duration-200 hover:translate-x-1"
                >
                  {/* Timeline Index Node indicator */}
                  <div className={`absolute -left-9 sm:-left-[35px] top-6 w-6 sm:w-8 h-6 sm:h-8 rounded-full flex items-center justify-center text-[10px] sm:text-xs font-bold border-2 transition-all ${
                    card.status === 'completed'
                      ? 'bg-green-500 border-green-500 text-white shadow-md'
                      : card.status === 'failed'
                      ? 'bg-red-500 border-red-500 text-white shadow-md'
                      : card.status !== 'idle'
                      ? 'bg-[#D4AF37] border-[#D4AF37] text-white animate-pulse'
                      : 'bg-white border-[#D4AF37] text-[#D4AF37]'
                  }`}>
                    {index + 1}
                  </div>

                  {/* Dialogue Card Box */}
                  <div className="bg-white rounded-2xl border border-gray-150 p-5 shadow-sm hover:shadow-md transition-all">
                    {/* Card Actions Header */}
                    <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4">
                      <div className="flex items-center gap-3">
                        {avatar ? (
                          <img
                            src={avatar}
                            alt={char?.name || 'Character'}
                            className="w-8 h-8 rounded-full object-cover border border-gray-200"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
                            👤
                          </div>
                        )}
                        <span className="text-sm font-semibold text-[#1A1A1A] font-display">
                          {char?.name || 'เลือกตัวละคร'}
                        </span>
                      </div>

                      {/* Control controls */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => moveCardUp(index)}
                          disabled={index === 0}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-30"
                          title="เลื่อนขึ้น"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => moveCardDown(index)}
                          disabled={index === cards.length - 1}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-30"
                          title="เลื่อนลง"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteCard(card.id)}
                          disabled={cards.length === 1}
                          className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 ml-2"
                          title="ลบประโยคนี้"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Card Options Fields */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                      {/* Left: Input parameters */}
                      <div className="lg:col-span-8 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {/* Character Select */}
                          <div>
                            <div className="flex justify-between items-center mb-1.5">
                              <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider font-thai">
                                ตัวละครผู้พูด
                              </label>
                              {/* Tagged Check Indicator */}
                              {faceTags.some(tag => tag.characterId === card.characterId) && (
                                <span className="text-[9px] font-bold bg-amber-50 text-amber-700 border border-amber-300 px-1.5 py-0.5 rounded-md font-thai flex items-center gap-0.5 animate-pulse">
                                  🎯 พิกัดเชื่อมโยงแล้ว
                                </span>
                              )}
                            </div>
                            <select
                              value={card.characterId}
                              onChange={(e) => updateCard(card.id, { characterId: e.target.value })}
                              className="w-full px-3 py-2 border border-gray-200 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
                            >
                              {characterList.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} {c.lora_status === 'completed' ? '✨ [LoRA Active]' : ''}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Voice Select */}
                          <div>
                            <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider font-thai">
                              เสียงพูด
                            </label>
                            <div className="flex gap-2">
                              <select
                                value={activeVoiceId}
                                onChange={(e) => updateCard(card.id, { voiceId: e.target.value })}
                                className="flex-1 px-3 py-2 border border-gray-200 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
                              >
                                {providerVoices.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.label}
                                  </option>
                                ))}
                              </select>
                              {activeVoiceId && (
                                <button
                                  type="button"
                                  onClick={() => handleVoicePreview(activeVoiceId)}
                                  className={`p-2 rounded-xl border transition-all ${
                                    playingVoice === activeVoiceId
                                      ? 'bg-amber-100 text-amber-700 border-amber-300'
                                      : 'bg-gray-50 hover:bg-gray-150 border-gray-200 text-gray-500'
                                  }`}
                                  title="ทดลองฟังเสียง"
                                >
                                  {playingVoice === activeVoiceId ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Volume2 className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Script Input Textarea */}
                        <div>
                          <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider font-thai">
                            บทพากย์ / สคริปต์พูด (ภาษาไทย)
                          </label>
                          <textarea
                            value={card.scriptText}
                            onChange={(e) => updateCard(card.id, { scriptText: e.target.value })}
                            className="w-full px-4 py-2.5 border border-gray-200 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai"
                            rows={2}
                            placeholder="พิมพ์บทพากย์ที่ต้องการให้ตัวละครนี้พูดที่นี่..."
                          />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {/* Speed slider */}
                          <div>
                            <div className="flex justify-between items-center mb-1.5">
                              <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wider font-thai">
                                ความเร็วการพูด (Speed)
                              </label>
                              <span className="text-xs font-semibold text-[#D4AF37]">
                                {card.speedFactor.toFixed(1)}x
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0.8"
                              max="1.5"
                              step="0.1"
                              value={card.speedFactor}
                              onChange={(e) => updateCard(card.id, { speedFactor: parseFloat(e.target.value) })}
                              className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                            />
                          </div>

                          {/* Emotion dropdown */}
                          <div>
                            <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider font-thai">
                              สีหน้าและอารมณ์ผู้พูด
                            </label>
                            <select
                              value={card.emotion}
                              onChange={(e) => updateCard(card.id, { emotion: e.target.value as any })}
                              className="w-full px-3 py-2 border border-gray-200 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
                            >
                              <option value="normal">ปกติ (Neutral)</option>
                              <option value="shocked">😮 ตกใจสุดขีด (Shocked)</option>
                              <option value="happy">😊 ยิ้มแย้มสดใส (Happy)</option>
                              <option value="sad">😢 ร้องไห้เสียใจ (Sad)</option>
                              <option value="angry">😡 โกรธเคือง (Angry)</option>
                              <option value="custom">🎭 กำหนดเอง (Custom Tag)</option>
                            </select>

                            {card.emotion === 'custom' && (
                              <input
                                type="text"
                                value={card.customEmotionText}
                                onChange={(e) => updateCard(card.id, { customEmotionText: e.target.value })}
                                className="w-full mt-2 px-3 py-2 border border-gray-200 text-xs rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai"
                                placeholder="พิมพ์ข้อความอธิบาย เช่น smiling slightly, raised eyebrows"
                              />
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: Render / Status section */}
                      <div className="lg:col-span-4 bg-gray-50 border border-gray-100 rounded-xl p-4 flex flex-col justify-between items-center text-center min-h-[170px]">
                        {card.status === 'idle' && (
                          <div className="flex-1 flex flex-col justify-center items-center py-4 space-y-3">
                            <Film className="w-10 h-10 text-gray-300" />
                            <p className="text-xs text-gray-500 font-thai">
                              พร้อมสำหรับการสร้างวิดีโอย่อย
                            </p>
                            <button
                              onClick={() => generateCardVideo(card.id)}
                              disabled={batchGenerating}
                              className="px-4 py-2 bg-[#1A1A1A] hover:bg-black text-[#D4AF37] font-semibold text-xs rounded-xl shadow-sm transition-all disabled:opacity-50 font-thai flex items-center gap-1.5"
                            >
                              <Video className="w-3.5 h-3.5" /> เจนคลิปนี้
                            </button>
                          </div>
                        )}

                        {(card.status === 'generating' || card.status === 'polling') && (
                          <div className="flex-1 flex flex-col justify-center items-center py-4 w-full">
                            <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin mb-3" />
                            <p className="text-xs font-semibold text-gray-700 font-thai truncate max-w-full">
                              {card.progressMessage || 'กำลังทำงาน...'}
                            </p>
                            
                            {card.progressPercent !== undefined && (
                              <div className="w-full mt-3">
                                <div className="flex justify-between items-center mb-1 text-[10px] text-gray-400">
                                  <span>ความคืบหน้า</span>
                                  <span>{card.progressPercent}%</span>
                                </div>
                                <div className="w-full bg-gray-200 rounded-full h-1.5">
                                  <div
                                    className="bg-[#D4AF37] h-1.5 rounded-full transition-all duration-300"
                                    style={{ width: `${card.progressPercent}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {card.status === 'completed' && card.videoUrl && (
                          <div className="w-full flex-1 flex flex-col justify-between items-center h-full">
                            <div className="relative w-full aspect-[16/9] bg-black rounded-lg overflow-hidden border border-gray-200">
                              <video
                                src={card.videoUrl}
                                controls
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <div className="flex items-center gap-1.5 mt-2.5">
                              <span className="text-[11px] font-semibold text-green-600 font-thai flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5" /> สำเร็จ
                              </span>
                              <button
                                onClick={() => generateCardVideo(card.id)}
                                disabled={batchGenerating}
                                className="text-[10px] text-gray-400 hover:text-gray-600 underline font-thai"
                              >
                                เจนใหม่
                              </button>
                            </div>
                          </div>
                        )}

                        {card.status === 'failed' && (
                          <div className="flex-1 flex flex-col justify-center items-center py-4 space-y-3 w-full">
                            <AlertCircle className="w-8 h-8 text-red-500" />
                            <p className="text-[11px] text-red-500 font-thai font-medium max-h-16 overflow-y-auto w-full leading-normal">
                              {card.progressMessage || 'การเจนคลิปนี้ล้มเหลว'}
                            </p>
                            <button
                              onClick={() => generateCardVideo(card.id)}
                              disabled={batchGenerating}
                              className="px-3.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-xs border border-red-200 rounded-lg transition-all font-thai"
                            >
                              ลองใหม่
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Dialogue Row Button */}
          <div className="flex justify-start pl-6 sm:pl-10">
            <button
              onClick={addCard}
              disabled={batchGenerating || merging}
              className="flex items-center gap-2 px-5 py-3 border-2 border-dashed border-gray-300 rounded-2xl text-sm font-semibold text-gray-500 hover:text-[#D4AF37] hover:border-[#D4AF37] hover:bg-[#D4AF37]/5 transition-all font-thai"
            >
              <Plus className="w-4 h-4" /> เพิ่มบทสนทนาถัดไป (Add Sentence)
            </button>
          </div>

          {/* Action Zone: Batch Generate & Concatenate */}
          <div className="border-t border-gray-150 pt-8 mt-10 space-y-6">
            <div className="flex flex-col sm:flex-row justify-between gap-4">
              {/* Batch Action */}
              <button
                onClick={generateAllClips}
                disabled={batchGenerating || merging || cards.every((c) => c.status === 'completed')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-4 rounded-2xl font-semibold text-sm transition-all shadow-sm ${
                  batchGenerating
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-[#1A1A1A] hover:bg-black text-[#D4AF37] active:scale-[0.99]'
                } font-thai`}
              >
                {batchGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#D4AF37]" />
                    <span>กำลังสร้างวิดีโอย่อย ({currentGeneratingIndex !== null ? `${currentGeneratingIndex + 1}/${cards.length}` : '...'})</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-[#D4AF37]" />
                    <span>สร้างวิดีโอทั้งหมด (Generate All Clips)</span>
                  </>
                )}
              </button>

              {/* Merge Action */}
              <button
                onClick={mergeFinalVideo}
                disabled={!canMerge || batchGenerating || merging}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-8 py-4 rounded-2xl font-bold text-sm transition-all shadow-md ${
                  canMerge && !merging && !batchGenerating
                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white hover:from-amber-600 hover:to-amber-700 active:scale-[0.99] border-t border-amber-300'
                    : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed shadow-none'
                } font-thai`}
              >
                {merging ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>กำลังเชื่อมต่อวิดีโอ...</span>
                  </>
                ) : (
                  <>
                    <Film className="w-4 h-4" />
                    <span>ต่อรวมวิดีโอ (Merge Final Video)</span>
                  </>
                )}
              </button>
            </div>

            {/* Error messaging */}
            {mergeError && (
              <div className="bg-red-50 border border-red-200 p-4 rounded-2xl flex gap-3 text-red-700 text-sm font-thai">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                <div>
                  <h5 className="font-semibold mb-1">เกิดข้อผิดพลาด</h5>
                  <p>{mergeError}</p>
                </div>
              </div>
            )}

            {/* Merge Video Result Output */}
            {mergedVideoUrl && (
              <div
                id="merged-video-result"
                className="bg-gradient-to-b from-[#FAF8F5] to-white border-2 border-[#D4AF37]/20 p-6 rounded-3xl space-y-4 shadow-sm"
              >
                <div className="flex items-center gap-3 border-b border-gray-100 pb-3">
                  <div className="w-8 h-8 rounded-full bg-[#D4AF37]/10 flex items-center justify-center text-[#D4AF37]">
                    🎉
                  </div>
                  <div>
                    <h4 className="font-semibold text-gray-800 font-display">
                      วิดีโอบทสนทนาสำเร็จรูปของคุณ
                    </h4>
                    <p className="text-xs text-gray-500 font-thai">
                      ต่อเชื่อมบทสนทนาเรียบร้อยพร้อมดาวน์โหลดและนำไปใช้งาน
                    </p>
                  </div>
                </div>

                <div className="relative max-w-2xl mx-auto aspect-[16/9] bg-black rounded-2xl overflow-hidden border border-gray-200 shadow-md">
                  <video
                    src={mergedVideoUrl}
                    controls
                    className="w-full h-full object-contain"
                  />
                </div>

                <div className="flex justify-center gap-3 pt-2">
                  <a
                    href={mergedVideoUrl}
                    download={`${projectTitle.replace(/\s+/g, '_')}_merged.mp4`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-6 py-2.5 bg-[#1A1A1A] hover:bg-black text-[#D4AF37] font-semibold text-xs rounded-xl shadow-sm transition-all font-thai"
                  >
                    ดาวน์โหลดวิดีโอ
                  </a>
                  <a
                    href="/gallery"
                    className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold text-xs rounded-xl border border-gray-200 transition-all font-thai"
                  >
                    ดูแกลลอรี่ประวัติ
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

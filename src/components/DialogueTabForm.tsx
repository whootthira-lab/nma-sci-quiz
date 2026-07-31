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
  HelpCircle,
  Upload
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
  // Optional columns: when present, a character always speaks with the same voice.
  // Absent on older databases — the UI falls back to reusing the voice from other cards.
  default_voice_id?: string;
  default_tts_provider?: 'google' | 'openai' | 'cosyvoice';
}
// A scene owns its own background image and face tags, so a project can change location.
// Clips within a scene are composited onto that scene's image; scenes are then joined.
interface SceneData {
  id: string;
  name: string;
  imageFile: File | null;
  imagePreview: string | null;
  faceTags: FaceTag[];
}

interface DialogueCardData {
  id: string;
  sceneId: string;
  characterId: string;
  voiceId: string;
  ttsProvider: 'google' | 'openai' | 'cosyvoice'; // per-card voice provider (overrides the global default)
  audioFile?: File | null; // optional uploaded audio → used instead of TTS for this line
  audioName?: string;
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
      sceneId: 'scene-1',
      characterId: '',
      voiceId: '',
      ttsProvider: 'google',
      audioFile: null,
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

  // Automation (one-click: generate every clip, then stitch into one long video)
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStage, setAutoStage] = useState<string>('');
  const [videoModel, setVideoModel] = useState<'fast' | 'seedance' | 'veo3' | 'sora2'>('fast');
  // Premium engines are gated by an admin switch (system_settings.automation_premium_enabled)
  const [premiumAllowed, setPremiumAllowed] = useState(false);

  // Merging state
  const [merging, setMerging] = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Audio preview helper
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Scenes: each one carries its own background image and face tags
  const [scenes, setScenes] = useState<SceneData[]>([
    { id: 'scene-1', name: 'ฉากที่ 1', imageFile: null, imagePreview: null, faceTags: [] }
  ]);

  const updateScene = (sceneId: string, updates: Partial<SceneData>) => {
    setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...updates } : s)));
  };

  const sceneOf = (card: DialogueCardData) =>
    scenes.find((s) => s.id === card.sceneId) || scenes[0];

  const handleSceneImageChange = (sceneId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const prev = scenes.find((s) => s.id === sceneId);
    if (prev?.imagePreview) URL.revokeObjectURL(prev.imagePreview);
    // Tags are coordinates on the old image, so they can't carry over
    updateScene(sceneId, { imageFile: file, imagePreview: URL.createObjectURL(file), faceTags: [] });
  };

  const clearSceneImage = (sceneId: string) => {
    const prev = scenes.find((s) => s.id === sceneId);
    if (prev?.imagePreview) URL.revokeObjectURL(prev.imagePreview);
    updateScene(sceneId, { imageFile: null, imagePreview: null, faceTags: [] });
  };

  const addScene = () => {
    const id = `scene-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setScenes((prev) => [...prev, { id, name: `ฉากที่ ${prev.length + 1}`, imageFile: null, imagePreview: null, faceTags: [] }]);
    // Start the new scene with one line so it is never empty
    const defaultCharId = characterList.length > 0 ? characterList[0].id : '';
    const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
    setCards((prev) => [
      ...prev,
      {
        id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        sceneId: id,
        characterId: defaultCharId,
        voiceId: providerVoices.length > 0 ? providerVoices[0].id : '',
        ttsProvider,
        audioFile: null,
        scriptText: '',
        speedFactor: 1.0,
        emotion: 'normal',
        customEmotionText: '',
        status: 'idle'
      }
    ]);
  };

  const deleteScene = (sceneId: string) => {
    if (scenes.length === 1) return;
    const prev = scenes.find((s) => s.id === sceneId);
    if (prev?.imagePreview) URL.revokeObjectURL(prev.imagePreview);
    setScenes((s) => s.filter((x) => x.id !== sceneId));
    setCards((prev) => prev.filter((c) => c.sceneId !== sceneId));
  };

  // Set the voice for one tagged person inside a scene: applies to every line
  // that character speaks in that scene.
  const setSceneCharacterVoice = (
    sceneId: string,
    characterId: string,
    voiceId: string,
    provider: DialogueCardData['ttsProvider']
  ) => {
    setCards((prev) =>
      prev.map((c) =>
        c.sceneId === sceneId && c.characterId === characterId
          ? { ...c, voiceId, ttsProvider: provider }
          : c
      )
    );
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

  // Read the admin switch that allows premium engines in automation mode
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('system_settings')
      .select('key, value')
      .eq('key', 'automation_premium_enabled')
      .maybeSingle()
      .then(({ data }: any) => {
        const allowed = data ? data.value === 'true' : false;
        setPremiumAllowed(allowed);
        // If premium got switched off while a premium engine was selected, fall back to the cheap one
        if (!allowed) {
          setVideoModel((m) => (m === 'veo3' || m === 'sora2' ? 'fast' : m));
        }
      });
  }, []);

  // A character should sound the same everywhere. Resolve their voice in order:
  // saved default on the character → voice already used by another card for them → unchanged.
  const resolveVoiceForCharacter = (characterId: string, fallback: { voiceId: string; ttsProvider: DialogueCardData['ttsProvider'] }) => {
    const char = characterList.find((c) => c.id === characterId);
    if (char?.default_voice_id) {
      const known = THAI_VOICES.find((v) => v.id === char.default_voice_id);
      return {
        voiceId: char.default_voice_id,
        ttsProvider: (char.default_tts_provider || known?.provider || fallback.ttsProvider) as DialogueCardData['ttsProvider']
      };
    }
    const sibling = cards.find((c) => c.characterId === characterId && c.voiceId);
    if (sibling) {
      return { voiceId: sibling.voiceId, ttsProvider: sibling.ttsProvider };
    }
    return fallback;
  };

  const handleCardCharacterChange = (cardId: string, characterId: string) => {
    const card = cards.find((c) => c.id === cardId);
    const resolved = resolveVoiceForCharacter(characterId, {
      voiceId: card?.voiceId || '',
      ttsProvider: card?.ttsProvider || 'google'
    });
    updateCard(cardId, { characterId, ...resolved });
  };

  // Persist the current voice as this character's default (needs the optional columns).
  const [savingVoiceFor, setSavingVoiceFor] = useState<string | null>(null);
  const saveDefaultVoice = async (card: DialogueCardData) => {
    if (!card.characterId || !card.voiceId || !supabase) return;
    setSavingVoiceFor(card.id);
    try {
      const { error } = await supabase
        .from('characters')
        .update({ default_voice_id: card.voiceId, default_tts_provider: card.ttsProvider })
        .eq('id', card.characterId);
      if (error) throw error;

      setCharacterList((prev) =>
        prev.map((c) =>
          c.id === card.characterId
            ? { ...c, default_voice_id: card.voiceId, default_tts_provider: card.ttsProvider }
            : c
        )
      );
      // Apply to every other card using this character so the whole script stays consistent
      setCards((prev) =>
        prev.map((c) =>
          c.characterId === card.characterId
            ? { ...c, voiceId: card.voiceId, ttsProvider: card.ttsProvider }
            : c
        )
      );
    } catch (err: any) {
      console.error('[Default Voice] save failed:', err);
      setMergeError(
        'ยังบันทึกเสียงประจำตัวไม่ได้ — ฐานข้อมูลยังไม่มีคอลัมน์ default_voice_id (ดูคำแนะนำการเพิ่มคอลัมน์) แต่เสียงจะยังใช้ตรงกันภายในบทนี้'
      );
    } finally {
      setSavingVoiceFor(null);
    }
  };

  // Characters that ended up with more than one voice across the script
  const inconsistentCharacterIds = (() => {
    const map = new Map<string, Set<string>>();
    cards.forEach((c) => {
      if (!c.characterId || !c.voiceId) return;
      if (!map.has(c.characterId)) map.set(c.characterId, new Set());
      map.get(c.characterId)!.add(c.voiceId);
    });
    return new Set(Array.from(map.entries()).filter(([, v]) => v.size > 1).map(([k]) => k));
  })();

  // ── Speech length & auto-splitting ────────────────────────────────────────
  // Thai TTS runs at roughly 15 characters per second.
  const CHARS_PER_SECOND = 15;
  const speechSecondsOf = (text: string, speed: number) =>
    Math.max(1, Math.ceil((text.replace(/\s+/g, '').length / CHARS_PER_SECOND) / speed));

  // Each engine renders a clip of a fixed menu of lengths, and lip-sync trims audio to the
  // video (cut_off). A line must therefore speak for less than the clip it will be given.
  const maxSpeechSecondsFor = (model: typeof videoModel) =>
    model === 'veo3' || model === 'sora2' ? 6 : 8;
  const maxSpeechSeconds = maxSpeechSecondsFor(videoModel);

  // Split a script so every piece fits the limit, preferring natural breaks:
  // sentence punctuation first, then spaces, and only then a hard character cut.
  const splitScript = (text: string, maxSeconds: number, speed: number): string[] => {
    const maxChars = Math.max(20, Math.floor(maxSeconds * CHARS_PER_SECOND * speed));
    const lenOf = (s: string) => s.replace(/\s+/g, '').length;

    const packed: string[] = [];
    const pack = (pieces: string[], joiner: string) => {
      let cur = '';
      for (const piece of pieces) {
        const candidate = cur ? cur + joiner + piece : piece;
        if (cur && lenOf(candidate) > maxChars) {
          packed.push(cur);
          cur = piece;
        } else {
          cur = candidate;
        }
      }
      if (cur) packed.push(cur);
    };

    // 1) sentence-ish units
    const sentences = text
      .split(/(?<=[.!?…ฯ])\s*/g)
      .map((s) => s.trim())
      .filter(Boolean);
    pack(sentences.length ? sentences : [text.trim()], ' ');

    // 2) any unit still too long → split on spaces, then hard-cut
    const result: string[] = [];
    for (const chunk of packed) {
      if (lenOf(chunk) <= maxChars) {
        result.push(chunk);
        continue;
      }
      const words = chunk.split(/\s+/).filter(Boolean);
      let cur = '';
      const flush = () => {
        if (cur) {
          result.push(cur);
          cur = '';
        }
      };
      for (const w of words) {
        if (lenOf(w) > maxChars) {
          flush();
          // Thai often has no spaces, so a "word" can be a whole sentence. Break after a
          // polite ending particle or before a connective — far more natural than cutting
          // mid-syllable, which is the last resort below.
          const units = w
            .split(/(?<=(?:ครับ|ค่ะ|คะ|นะคะ|นะครับ|จ้ะ|ค่า))|(?=(?:และ|แต่|เมื่อ|ซึ่ง|แล้ว|จึง|เพราะ|หรือ|ถ้า|ดังนั้น))/g)
            .filter(Boolean);
          let sub = '';
          for (const u of units) {
            if (lenOf(u) > maxChars) {
              if (sub) { result.push(sub); sub = ''; }
              for (let i = 0; i < u.length; i += maxChars) result.push(u.slice(i, i + maxChars));
              continue;
            }
            const cand = sub + u;
            if (sub && lenOf(cand) > maxChars) {
              result.push(sub);
              sub = u;
            } else {
              sub = cand;
            }
          }
          if (sub) result.push(sub);
          continue;
        }
        const candidate = cur ? cur + ' ' + w : w;
        if (cur && lenOf(candidate) > maxChars) {
          flush();
          cur = w;
        } else {
          cur = candidate;
        }
      }
      flush();
    }

    return result.length ? result : [text];
  };

  const isCardTooLong = (card: DialogueCardData) =>
    !!card.scriptText.trim() && speechSecondsOf(card.scriptText, card.speedFactor) > maxSpeechSeconds;
  const tooLongCards = cards.filter(isCardTooLong);

  // Replace a long card with several cards in place, keeping character, voice and emotion.
  const splitCard = (cardId: string) => {
    setCards((prev) => {
      const idx = prev.findIndex((c) => c.id === cardId);
      if (idx === -1) return prev;
      const card = prev[idx];
      const pieces = splitScript(card.scriptText, maxSpeechSeconds, card.speedFactor);
      if (pieces.length <= 1) return prev;
      const made = pieces.map((text, i) => ({
        ...card,
        id: i === 0 ? card.id : `card-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`,
        scriptText: text,
        // Splitting invalidates any clip already rendered for the original line
        status: 'idle' as const,
        videoUrl: undefined,
        progressPercent: undefined,
        progressMessage: undefined,
        audioFile: null,
        audioName: undefined
      }));
      return [...prev.slice(0, idx), ...made, ...prev.slice(idx + 1)];
    });
  };

  const splitAllLongCards = () => {
    tooLongCards.forEach((c) => splitCard(c.id));
  };

  // Per-card clip length, mirroring the rule used when generating (15 chars ≈ 1s, +2s padding)
  const estimateCardDuration = (card: DialogueCardData) =>
    speechSecondsOf(card.scriptText, card.speedFactor) + 2 <= 5 ? 5 : 10;

  const MAX_TOTAL_SECONDS = 120; // hard cap for the automated long video
  const totalEstimatedSeconds = cards.reduce((sum, c) => sum + estimateCardDuration(c), 0);
  const overDurationCap = totalEstimatedSeconds > MAX_TOTAL_SECONDS;

  // The global provider select acts as a "apply to all cards" bulk control:
  // set every card's provider (and fix its voice) when it changes. Per-card selects still override.
  useEffect(() => {
    const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
    if (providerVoices.length > 0) {
      const defaultVoice = providerVoices[0].id;
      setCards((prev) =>
        prev.map((c) => {
          const voiceExists = providerVoices.some((v) => v.id === c.voiceId);
          return { ...c, ttsProvider, voiceId: voiceExists ? c.voiceId : defaultVoice };
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

  // Add card (appended at the end of the given scene)
  const addCard = (sceneId: string) => {
    const providerVoices = THAI_VOICES.filter((v) => v.provider === ttsProvider);
    const defaultVoice = providerVoices.length > 0 ? providerVoices[0].id : '';
    const defaultCharId = characterList.length > 0 ? characterList[0].id : '';

    setCards((prev) => [
      ...prev,
      {
        id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        sceneId,
        characterId: defaultCharId,
        voiceId: defaultVoice,
        ttsProvider: ttsProvider, // inherit the current global default at creation time
        audioFile: null,
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
      
      // Is this character tagged on this card's own scene image?
      const cardScene = sceneOf(card);
      const linkedTag = cardScene?.faceTags.find(t => t.characterId === card.characterId);
      if (cardScene?.imagePreview && linkedTag) {
        updateCard(cardId, {
          status: 'generating',
          progressMessage: 'กำลังครอปรูปภาพใบหน้า...'
        });
        const croppedResult = await cropFaceImage(cardScene.imagePreview, linkedTag);
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
      // If the card has an uploaded audio file, use it instead of TTS (backend reads `custom_audio`)
      if (card.audioFile) {
        formData.append('custom_audio', card.audioFile);
      } else {
        formData.append('tts_provider', card.ttsProvider);
        formData.append('voice_id', card.voiceId);
      }
      formData.append('aspect_ratio', aspectRatio);
      formData.append('user_email', user?.email || '');
      formData.append('user_id', user?.id || '');
      // Premium engines are only reachable when the admin switch allows them
      const effectiveModel = (videoModel === 'veo3' || videoModel === 'sora2') && !premiumAllowed ? 'fast' : videoModel;
      formData.append('model_type', effectiveModel);
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

  // One merge request. Returns the merged clip URL.
  const callMergeApi = async (
    clips: any[],
    baseImageUrl: string | null,
    tags: FaceTag[] | null,
    label: string,
    normalize = false,
    trimSilence = false
  ): Promise<string> => {
    const response = await fetch('/api/merge-dialogue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: label,
        videoClips: clips,
        user_email: user?.email || '',
        user_id: user?.id || '',
        aspectRatio,
        baseImageUrl,
        faceTags: tags && tags.length > 0 ? tags : null,
        normalize,
        trimSilence
      })
    });
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'เกิดข้อผิดพลาดทางเทคนิคในการรวมคลิป');
    }
    return result.videoUrl as string;
  };

  const toClip = (c: DialogueCardData) => ({
    videoUrl: c.videoUrl as string,
    cropX: c.cropX ?? null,
    cropY: c.cropY ?? null,
    cropW: c.cropW ?? null,
    cropH: c.cropH ?? null
  });
  const toPlainClip = (url: string) => ({
    videoUrl: url,
    cropX: null,
    cropY: null,
    cropW: null,
    cropH: null
  });

  const uploadSceneImage = async (scene: SceneData): Promise<string | null> => {
    if (!scene.imageFile || !supabase) return null;
    const fileExt = scene.imageFile.name.split('.').pop() || 'png';
    const storagePath = `dialogue_bases/${user?.email || 'unknown'}/${Date.now()}_${scene.id}.${fileExt}`;
    const { error } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(storagePath, scene.imageFile, { upsert: true });
    if (error) throw new Error(`อัปโหลดรูปภาพฉากหลังล้มเหลว: ${error.message}`);
    const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(storagePath);
    return publicUrl;
  };

  // Merge one scene: its clips are composited onto that scene's background.
  // Long scenes are stitched in groups so no single request nears the 300s limit.
  const MERGE_CHUNK = 8;
  const mergeScene = async (scene: SceneData, sceneCards: DialogueCardData[]): Promise<string> => {
    const baseUrl = await uploadSceneImage(scene);
    const clips = sceneCards.map(toClip);

    // Nothing to composite and nothing to join → the clip is already the scene
    if (clips.length === 1 && !baseUrl) return clips[0].videoUrl;

    if (clips.length <= MERGE_CHUNK) {
      return callMergeApi(clips, baseUrl, scene.faceTags, scene.name, false, true);
    }

    const parts: string[] = [];
    for (let i = 0; i < clips.length; i += MERGE_CHUNK) {
      const groupNo = Math.floor(i / MERGE_CHUNK) + 1;
      setAutoStage(`${scene.name}: กำลังต่อคลิป ช่วงที่ ${groupNo}...`);
      parts.push(
        await callMergeApi(clips.slice(i, i + MERGE_CHUNK), baseUrl, scene.faceTags, `${scene.name} (ช่วง ${groupNo})`, false, true)
      );
    }
    return callMergeApi(parts.map(toPlainClip), null, null, scene.name, true);
  };

  // Merge the whole project: each scene first, then the scenes together (normalized,
  // because different scenes can have differently sized backgrounds).
  const mergeProject = async (allCards: DialogueCardData[]): Promise<string> => {
    const sceneOutputs: string[] = [];
    for (const scene of scenes) {
      const sceneCards = allCards.filter((c) => c.sceneId === scene.id);
      if (sceneCards.length === 0) continue;
      setAutoStage(`กำลังประกอบ ${scene.name}...`);
      sceneOutputs.push(await mergeScene(scene, sceneCards));
    }

    if (sceneOutputs.length === 0) throw new Error('ไม่พบคลิปสำหรับรวม');
    if (sceneOutputs.length === 1) return sceneOutputs[0];

    setAutoStage('กำลังรวมทุกฉากเป็นคลิปเดียว...');
    return callMergeApi(sceneOutputs.map(toPlainClip), null, null, projectTitle, true);
  };

  // Merge finished clips together
  const mergeFinalVideo = async () => {
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

    try {
      const finalUrl = await mergeProject(cards);
      setMergedVideoUrl(finalUrl);
      setAutoStage('');
      setTimeout(() => {
        document.getElementById('merged-video-result')?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch (err: any) {
      console.error('[Merge Video Error]', err);
      setMergeError(err.message || 'รวมวิดีโอล้มเหลว');
      setAutoStage('');
    } finally {
      setMerging(false);
    }
  };

  // Automation reads the freshest cards through a ref: after awaiting generation the
  // `cards` value captured in this closure is stale and has no videoUrls yet.
  const cardsRef = useRef<DialogueCardData[]>(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // One click: generate every clip in order, then stitch them into a single long video.
  const runAutomation = async () => {
    if (autoRunning || batchGenerating || merging) return;

    if (cards.length < 2) {
      setMergeError('โหมดอัตโนมัติต้องมีบทสนทนาอย่างน้อย 2 ประโยค');
      return;
    }
    if (tooLongCards.length > 0) {
      setMergeError(
        `มี ${tooLongCards.length} บทที่พูดยาวเกิน ${maxSpeechSeconds} วินาที ซึ่งเกินความยาวคลิปที่โมเดลนี้สร้างได้ กรุณากด "หั่นบททั้งหมดอัตโนมัติ" ก่อนเริ่ม`
      );
      return;
    }
    if (overDurationCap) {
      setMergeError(
        `เนื้อหารวมยาวประมาณ ${totalEstimatedSeconds} วินาที ซึ่งเกินเพดาน ${MAX_TOTAL_SECONDS} วินาที (2 นาที) กรุณาลดจำนวนประโยคหรือย่อบทพูดลง`
      );
      return;
    }

    setAutoRunning(true);
    setMergeError(null);
    setMergedVideoUrl(null);

    try {
      setAutoStage('กำลังสร้างคลิปย่อยทีละฉาก...');
      await generateAllClips();

      const latest = cardsRef.current;
      const failed = latest.filter((c) => c.status !== 'completed' || !c.videoUrl);
      if (failed.length > 0) {
        throw new Error(
          `มี ${failed.length} ฉากที่สร้างไม่สำเร็จ กรุณากดสร้างใหม่เฉพาะฉากนั้น แล้วกดรวมคลิปอีกครั้ง`
        );
      }

      setAutoStage('กำลังเตรียมไฟล์สำหรับต่อคลิป...');
      const finalUrl = await mergeProject(latest);
      setMergedVideoUrl(finalUrl);
      setAutoStage('');
      setTimeout(() => {
        document.getElementById('merged-video-result')?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch (err: any) {
      console.error('[Automation Error]', err);
      setMergeError(err.message || 'โหมดอัตโนมัติทำงานไม่สำเร็จ');
      setAutoStage('');
    } finally {
      setAutoRunning(false);
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

          {/* TTS Provider (bulk default — applies to every card; each card can override) */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-2 font-thai">
              ผู้ให้บริการเสียง (ตั้งให้ทุกการ์ด — ปรับรายตัวได้ในแต่ละการ์ด)
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
          {scenes.map((scene) => {
          const sceneCards = cards.filter((c) => c.sceneId === scene.id);
          // Characters that are tagged on this scene's image, for the per-person voice controls
          const taggedInScene = scene.faceTags
            .map((t) => characterList.find((c) => c.id === t.characterId))
            .filter((c): c is Character => !!c);

          return (
          <div key={scene.id} className="rounded-3xl border border-gray-200 bg-white/60 p-5 space-y-5">
            {/* ── Scene header: name, background image, face tags, per-person voice ── */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="px-2.5 py-1 rounded-lg bg-[#1A1A1A] text-[#D4AF37] text-[11px] font-bold font-thai">ฉาก</span>
                <input
                  value={scene.name}
                  onChange={(e) => updateScene(scene.id, { name: e.target.value })}
                  className="flex-1 min-w-[140px] px-3 py-1.5 border border-gray-200 rounded-xl text-sm font-semibold font-thai focus:outline-none focus:ring-1 focus:ring-[#D4AF37]"
                  placeholder="ชื่อฉาก เช่น ในห้องเรียน"
                />
                <span className="text-[11px] text-gray-500 font-thai">{sceneCards.length} บท</span>
                {scenes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => deleteScene(scene.id)}
                    disabled={autoRunning || batchGenerating || merging}
                    className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30"
                    title="ลบฉากนี้ (พร้อมบทในฉาก)"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="bg-[#FAF8F5] border border-gray-100 p-4 rounded-2xl space-y-3">
                <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                  <div className="flex-1">
                    <label className="block text-[11px] font-semibold text-gray-600 mb-1.5 font-thai">
                      ภาพฉากนี้ (ทางเลือก — ใส่เพื่อให้ตัวละครพูดอยู่ร่วมเฟรมเดียวกัน)
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleSceneImageChange(scene.id, e)}
                      className="w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[11px] file:font-semibold file:bg-[#1A1A1A] file:text-[#D4AF37] hover:file:opacity-90 font-thai cursor-pointer"
                    />
                  </div>
                  {scene.imagePreview && (
                    <button
                      type="button"
                      onClick={() => clearSceneImage(scene.id)}
                      className="text-[11px] text-red-500 hover:text-red-700 font-thai font-semibold border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50 flex items-center gap-1.5 self-start sm:self-auto"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> ล้างรูปและแท็ก
                    </button>
                  )}
                </div>

                {scene.imagePreview && characterList.length > 0 && (
                  <div className="bg-white border border-gray-150 rounded-2xl p-4 shadow-inner">
                    <DialogueCanvasWorkspace
                      imageUrl={scene.imagePreview}
                      characters={characterList}
                      faceTags={scene.faceTags}
                      onTagsChange={(tags) => updateScene(scene.id, { faceTags: tags })}
                    />
                  </div>
                )}

                {/* Voice per tagged person in this scene */}
                {taggedInScene.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold text-gray-600 font-thai">เสียงของแต่ละคนในฉากนี้</p>
                    {taggedInScene.map((ch) => {
                      const sample = sceneCards.find((c) => c.characterId === ch.id);
                      const curProvider = sample?.ttsProvider || 'google';
                      const curVoice = sample?.voiceId || '';
                      return (
                        <div key={ch.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-150 rounded-xl px-3 py-2">
                          <span className="text-xs font-semibold text-[#1A1A1A] font-thai min-w-[90px]">👤 {ch.name}</span>
                          <select
                            value={curProvider}
                            onChange={(e) => {
                              const p = e.target.value as DialogueCardData['ttsProvider'];
                              const first = THAI_VOICES.find((v) => v.provider === p);
                              setSceneCharacterVoice(scene.id, ch.id, first ? first.id : '', p);
                            }}
                            className="px-2 py-1 border border-gray-200 rounded-lg text-[11px] font-thai bg-white"
                          >
                            <option value="google">🌐 Google</option>
                            <option value="cosyvoice">🔥 CosyVoice</option>
                            <option value="openai">🧠 OpenAI</option>
                          </select>
                          <select
                            value={curVoice}
                            onChange={(e) => setSceneCharacterVoice(scene.id, ch.id, e.target.value, curProvider)}
                            className="flex-1 min-w-[150px] px-2 py-1 border border-gray-200 rounded-lg text-xs font-thai bg-white"
                          >
                            {THAI_VOICES.filter((v) => v.provider === curProvider).map((v) => (
                              <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                          </select>
                          {curVoice && (
                            <button
                              type="button"
                              onClick={() => handleVoicePreview(curVoice)}
                              className="p-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"
                              title="ทดลองฟังเสียง"
                            >
                              {playingVoice === curVoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

          {/* Vertical Timeline wrapper */}
          <div className="relative pl-6 sm:pl-10 space-y-8 before:absolute before:left-3 sm:before:left-5 before:top-2 before:bottom-2 before:w-0.5 before:bg-gradient-to-b before:from-[#D4AF37] before:to-gray-200">
            {sceneCards.map((card) => {
              const index = cards.findIndex((c) => c.id === card.id);
              const char = characterList.find((c) => c.id === card.characterId);
              const avatar = getAvatarUrl(char);
              const providerVoices = THAI_VOICES.filter((v) => v.provider === card.ttsProvider);
              
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
                              {scene.faceTags.some(tag => tag.characterId === card.characterId) && (
                                <span className="text-[9px] font-bold bg-amber-50 text-amber-700 border border-amber-300 px-1.5 py-0.5 rounded-md font-thai flex items-center gap-0.5 animate-pulse">
                                  🎯 พิกัดเชื่อมโยงแล้ว
                                </span>
                              )}
                            </div>
                            <select
                              value={card.characterId}
                              onChange={(e) => handleCardCharacterChange(card.id, e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 text-sm rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
                            >
                              {characterList.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} {c.lora_status === 'completed' ? '✨ [LoRA Active]' : ''}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Voice: provider + voice, or attached audio file */}
                          <div>
                            <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider font-thai">
                              เสียงพูด
                            </label>

                            {card.audioFile ? (
                              <div className="flex items-center gap-2 px-3 py-2 border border-amber-300 bg-amber-50 rounded-xl text-xs text-amber-800 font-thai">
                                <span className="truncate flex-1">🎧 {card.audioName || 'ไฟล์เสียงที่แนบ'}</span>
                                <button
                                  type="button"
                                  onClick={() => updateCard(card.id, { audioFile: null, audioName: undefined })}
                                  className="text-red-500 hover:text-red-700 shrink-0"
                                  title="เอาไฟล์เสียงออก แล้วกลับไปใช้ TTS"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {/* Per-card TTS provider */}
                                <select
                                  value={card.ttsProvider}
                                  onChange={(e) => {
                                    const p = e.target.value as 'google' | 'openai' | 'cosyvoice';
                                    const first = THAI_VOICES.find((v) => v.provider === p);
                                    updateCard(card.id, { ttsProvider: p, voiceId: first ? first.id : '' });
                                  }}
                                  className="w-full px-3 py-2 border border-gray-200 text-xs rounded-xl focus:outline-none focus:ring-1 focus:ring-[#D4AF37] font-thai bg-white"
                                >
                                  <option value="google">🌐 Google (ไทยแท้)</option>
                                  <option value="cosyvoice">🔥 CosyVoice</option>
                                  <option value="openai">🧠 OpenAI</option>
                                </select>
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
                            )}

                            {/* Voice consistency: save as this character's default / warn on mismatch */}
                            {!card.audioFile && card.characterId && card.voiceId && (
                              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                                <button
                                  type="button"
                                  onClick={() => saveDefaultVoice(card)}
                                  disabled={savingVoiceFor === card.id}
                                  className="inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-[#D4AF37] disabled:opacity-50"
                                  title="ใช้เสียงนี้กับตัวละครนี้ทุกครั้ง"
                                >
                                  {savingVoiceFor === card.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="w-3 h-3" />
                                  )}
                                  ตั้งเป็นเสียงประจำตัวละครนี้
                                </button>
                                {inconsistentCharacterIds.has(card.characterId) && (
                                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-300 rounded-md px-1.5 py-0.5">
                                    <AlertCircle className="w-3 h-3" />
                                    ตัวละครนี้ใช้เสียงไม่ตรงกันในบทอื่น
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Attach own audio (overrides TTS for this line) */}
                            {!card.audioFile && (
                              <label className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-[#D4AF37] cursor-pointer font-thai">
                                <Upload className="w-3 h-3" /> แนบไฟล์เสียงเอง (ใช้แทน TTS)
                                <input
                                  type="file"
                                  accept="audio/*"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) updateCard(card.id, { audioFile: f, audioName: f.name });
                                    e.target.value = '';
                                  }}
                                />
                              </label>
                            )}
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
                          {isCardTooLong(card) && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-2 py-1.5">
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                              <span className="font-thai">
                                บทนี้พูดยาว ~{speechSecondsOf(card.scriptText, card.speedFactor)} วิ เกินคลิปที่โมเดลสร้างได้ ({maxSpeechSeconds} วิ) เสียงจะถูกตัด
                              </span>
                              <button
                                type="button"
                                onClick={() => splitCard(card.id)}
                                disabled={autoRunning || batchGenerating || merging}
                                className="ml-auto font-bold text-[#1A1A1A] underline hover:text-[#D4AF37] disabled:opacity-40 font-thai"
                              >
                                ✂️ หั่นบทนี้อัตโนมัติ
                              </button>
                            </div>
                          )}
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

          {/* Add Dialogue Row Button (within this scene) */}
          <div className="flex justify-start pl-6 sm:pl-10">
            <button
              onClick={() => addCard(scene.id)}
              disabled={autoRunning || batchGenerating || merging}
              className="flex items-center gap-2 px-5 py-3 border-2 border-dashed border-gray-300 rounded-2xl text-sm font-semibold text-gray-500 hover:text-[#D4AF37] hover:border-[#D4AF37] hover:bg-[#D4AF37]/5 transition-all font-thai disabled:opacity-40"
            >
              <Plus className="w-4 h-4" /> เพิ่มบทสนทนาในฉากนี้
            </button>
          </div>
          </div>
          );
          })}

          {/* Add Scene */}
          <div className="flex justify-center">
            <button
              onClick={addScene}
              disabled={autoRunning || batchGenerating || merging}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl border-2 border-dashed border-[#D4AF37]/50 text-sm font-bold text-[#D4AF37] hover:bg-[#D4AF37]/10 transition-all font-thai disabled:opacity-40"
            >
              <Plus className="w-4 h-4" /> เพิ่มฉากใหม่ (เปลี่ยนสถานที่/พื้นหลัง)
            </button>
          </div>

          {/* Action Zone: Batch Generate & Concatenate */}
          <div className="border-t border-gray-150 pt-8 mt-10 space-y-6">

            {/* Automation panel: one click from script to a single long video */}
            <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#D4AF37]/5 p-5 space-y-4 font-thai">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#D4AF37]" />
                <h3 className="text-sm font-bold text-[#1A1A1A]">โหมดอัตโนมัติ — สร้างคลิปยาวจากบททั้งหมด</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Engine picker */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider">
                    เครื่องยนต์วิดีโอ
                  </label>
                  <select
                    value={videoModel}
                    onChange={(e) => setVideoModel(e.target.value as typeof videoModel)}
                    disabled={autoRunning || batchGenerating || merging}
                    className="w-full px-3 py-2 border border-gray-200 text-sm rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#D4AF37] disabled:opacity-60"
                  >
                    <option value="fast">⚡ KRUTH Standard (ประหยัด — แนะนำ)</option>
                    <option value="seedance">🌊 KRUTH Nova (Seedance)</option>
                    {premiumAllowed && <option value="veo3">🎥 KRUTH Prism (Veo 3 — ราคาสูง)</option>}
                    {premiumAllowed && <option value="sora2">🌀 KRUTH Orbit (Sora 2 — ราคาสูง)</option>}
                  </select>
                  <p className="text-[10px] text-gray-500 mt-1.5">
                    {premiumAllowed
                      ? `⚠️ โมเดลพรีเมียมแพงกว่าราว 6–9 เท่า และรับบทได้ท่อนละไม่เกิน ~${maxSpeechSeconds} วิ`
                      : 'ผู้ดูแลระบบปิดการใช้โมเดลพรีเมียม (Veo 3 / Sora 2) สำหรับโหมดนี้ไว้'}
                  </p>
                </div>

                {/* Duration budget */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-500 mb-1.5 uppercase tracking-wider">
                    ความยาวรวมโดยประมาณ
                  </label>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className={overDurationCap ? 'text-red-600 font-bold' : 'text-[#1A1A1A] font-semibold'}>
                      {totalEstimatedSeconds} วินาที
                    </span>
                    <span className="text-[11px] text-gray-500">เพดาน {MAX_TOTAL_SECONDS} วิ (2 นาที)</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${overDurationCap ? 'bg-red-500' : 'bg-[#D4AF37]'}`}
                      style={{ width: `${Math.min(100, (totalEstimatedSeconds / MAX_TOTAL_SECONDS) * 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1.5">
                    {cards.length} ฉาก · {overDurationCap ? 'เกินเพดาน กรุณาลดบทพูดลง' : 'อยู่ในเกณฑ์'}
                  </p>
                </div>
              </div>

              {tooLongCards.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-300 rounded-xl px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    มี {tooLongCards.length} บทที่ยาวเกิน {maxSpeechSeconds} วินาที — เสียงจะถูกตัดถ้าไม่หั่นก่อน
                  </span>
                  <button
                    type="button"
                    onClick={splitAllLongCards}
                    disabled={autoRunning || batchGenerating || merging}
                    className="ml-auto font-bold text-[#1A1A1A] underline hover:text-[#D4AF37] disabled:opacity-40"
                  >
                    ✂️ หั่นบททั้งหมดอัตโนมัติ
                  </button>
                </div>
              )}

              <button
                onClick={runAutomation}
                disabled={autoRunning || batchGenerating || merging || cards.length < 2 || overDurationCap || tooLongCards.length > 0}
                className={`w-full flex items-center justify-center gap-2 px-6 py-4 rounded-2xl font-bold text-sm transition-all shadow-md ${
                  !autoRunning && !batchGenerating && !merging && cards.length >= 2 && !overDurationCap && tooLongCards.length === 0
                    ? 'bg-gradient-to-r from-[#D4AF37] to-amber-600 text-black hover:from-amber-500 hover:to-amber-700 active:scale-[0.99]'
                    : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed shadow-none'
                }`}
              >
                {autoRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>
                      {autoStage || 'กำลังทำงาน...'}
                      {batchGenerating && currentGeneratingIndex !== null
                        ? ` (${currentGeneratingIndex + 1}/${cards.length})`
                        : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <Video className="w-4 h-4" />
                    <span>▶︎ สร้างทั้งเรื่องอัตโนมัติ (สร้างทุกฉาก + ต่อเป็นคลิปเดียว)</span>
                  </>
                )}
              </button>
            </div>

            <div className="flex flex-col sm:flex-row justify-between gap-4">
              {/* Batch Action */}
              <button
                onClick={generateAllClips}
                disabled={autoRunning || batchGenerating || merging || cards.every((c) => c.status === 'completed')}
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
                disabled={!canMerge || autoRunning || batchGenerating || merging}
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

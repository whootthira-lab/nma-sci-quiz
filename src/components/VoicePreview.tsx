'use client';

import { useState, useRef } from 'react';
import { Volume2, VolumeX, Loader2 } from 'lucide-react';
import { THAI_VOICES, type ThaiVoice } from '@/types';

interface VoicePreviewProps {
  selectedVoice: string;
  onSelect: (voiceId: string) => void;
  ttsProvider?: 'botnoi' | 'google';
}

export default function VoicePreview({ selectedVoice, onSelect, ttsProvider = 'botnoi' }: VoicePreviewProps) {
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePreview = async (voice: ThaiVoice) => {
    if (playingVoice === voice.id) {
      audioRef.current?.pause();
      setPlayingVoice(null);
      return;
    }

    try {
      setPlayingVoice(voice.id);
      // In production, these would be actual sample MP3 files
      // For now, we attempt to play the sample URL
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(voice.sample_url);
      audioRef.current = audio;
      audio.onended = () => setPlayingVoice(null);
      audio.onerror = () => setPlayingVoice(null);
      await audio.play().catch(() => setPlayingVoice(null));
    } catch {
      setPlayingVoice(null);
    }
  };

  const filteredVoices = THAI_VOICES.filter((voice) => voice.provider === ttsProvider);

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-text-secondary font-thai">
        เลือกเสียงพากย์ภาษาไทย
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {filteredVoices.map((voice) => {
          const isSelected = selectedVoice === voice.id;
          const isPlaying = playingVoice === voice.id;

          return (
            <div
              key={voice.id}
              onClick={() => onSelect(voice.id)}
              className={`relative flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
                isSelected
                  ? 'bg-accent-primary/10 border border-accent-primary/30'
                  : 'bg-surface-2/50 border border-white/5 hover:border-white/10'
              }`}
            >
              {/* Gender Icon */}
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                  voice.gender === 'female'
                    ? 'bg-pink-500/10 text-pink-400'
                    : 'bg-blue-500/10 text-blue-400'
                }`}
              >
                {voice.gender === 'female' ? '♀' : '♂'}
              </div>

              {/* Voice Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary font-thai truncate">
                  {voice.label}
                </p>
              </div>

              {/* Preview Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePreview(voice);
                }}
                className={`p-2 rounded-lg transition-all ${
                  isPlaying
                    ? 'bg-accent-primary/20 text-accent-primary'
                    : 'bg-surface-3/50 text-text-muted hover:text-text-primary hover:bg-surface-3'
                }`}
                title="ตัวอย่างเสียง"
              >
                {isPlaying ? (
                  <VolumeX className="w-4 h-4" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>

              {/* Selection Indicator */}
              {isSelected && (
                <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-accent-primary" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

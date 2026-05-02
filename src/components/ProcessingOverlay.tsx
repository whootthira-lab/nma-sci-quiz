'use client';

import { Sparkles } from 'lucide-react';

interface ProcessingOverlayProps {
  isVisible: boolean;
  stage?: string;
  progress?: number;
}

export default function ProcessingOverlay({ isVisible, stage, progress }: ProcessingOverlayProps) {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0/85 backdrop-blur-xl">
      <div className="flex flex-col items-center gap-8 animate-fade-in">
        {/* Spinning Ring */}
        <div className="relative">
          <div className="processing-ring" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-accent-primary processing-pulse" />
          </div>
        </div>

        {/* Status */}
        <div className="text-center space-y-3">
          <h3 className="text-xl font-display font-semibold text-text-primary">
            กำลังประมวลผล
          </h3>
          {stage && (
            <p className="text-sm text-text-secondary font-thai">{stage}</p>
          )}
          {progress !== undefined && (
            <div className="w-64 h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-accent-primary to-accent-secondary rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          <p className="text-xs text-text-muted">
            กระบวนการนี้อาจใช้เวลา 1-5 นาที กรุณาอย่าปิดหน้าต่างนี้
          </p>
        </div>

        {/* Animated Dots */}
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-accent-primary"
              style={{
                animation: 'processingPulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.3}s`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

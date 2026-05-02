'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Sparkles, ShieldCheck, Film, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const { user, loading, error, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) router.push('/dashboard');
  }, [user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent-primary/5 blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-accent-secondary/5 blur-[100px]" />
      </div>

      {/* Login Card */}
      <div className="relative w-full max-w-md">
        <div className="glow-card glow-border p-8 sm:p-10">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center shadow-xl shadow-accent-primary/20 mb-5">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-display font-bold text-text-primary tracking-tight">
              AI Video Studio
            </h1>
            <p className="text-sm text-text-secondary mt-2 font-thai text-center">
              แพลตฟอร์มสร้างวิดีโอ AI สำหรับครูผู้สอน
            </p>
          </div>

          {/* Features */}
          <div className="space-y-3 mb-8">
            {[
              { icon: Film, text: 'สร้างวิดีโอสอนจากรูปภาพและบทพากย์' },
              { icon: Sparkles, text: 'เสียงพากย์ภาษาไทยคุณภาพสูง' },
              { icon: ShieldCheck, text: 'ระบบรักษาความปลอดภัยขั้นสูง' },
            ].map((feature, i) => {
              const Icon = feature.icon;
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-surface-2/30">
                  <Icon className="w-4 h-4 text-accent-primary flex-shrink-0" />
                  <span className="text-sm text-text-secondary font-thai">{feature.text}</span>
                </div>
              );
            })}
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-accent-danger/10 border border-accent-danger/20">
              <p className="text-sm text-accent-danger font-thai">{error}</p>
            </div>
          )}

          {/* Sign In Button */}
          <button
            onClick={signIn}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl font-medium text-white transition-all duration-300 bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <span className="font-thai">เข้าสู่ระบบด้วย Google</span>
          </button>

          <p className="text-[10px] text-text-muted text-center mt-4 font-thai">
            เฉพาะอีเมลที่ได้รับอนุญาตเท่านั้น (Whitelist System)
          </p>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import Navbar from '@/components/Navbar';
import VideoGallery from '@/components/VideoGallery';
import { Loader2 } from 'lucide-react';

export default function GalleryPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-display font-bold text-text-primary tracking-tight">
            คลังวิดีโอ
          </h1>
          <p className="text-sm text-text-secondary mt-1 font-thai">
            วิดีโอทั้งหมดที่คุณสร้างขึ้น · จะถูกลบอัตโนมัติภายใน 24 ชั่วโมง
          </p>
        </div>

        <VideoGallery refreshTrigger={refreshKey} />
      </main>
    </div>
  );
}

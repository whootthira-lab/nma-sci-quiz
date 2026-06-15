'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import Navbar from '@/components/Navbar';
import Mode1Form from '@/components/Mode1Form';
import Mode2Form from '@/components/Mode2Form';
import ImageTabForm from '@/components/ImageTabForm';
import DialogueTabForm from '@/components/DialogueTabForm';
import { Film, Scan, Loader2, Lock, Image as ImageIcon, MessageSquare } from 'lucide-react';

export default function DashboardPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'mode1' | 'image' | 'dialogue' | 'mode2'>('mode1');

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFBF7]">
        <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  const handleVideoGenerated = () => {
    router.push('/gallery');
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7]">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        
        {/* KRUTH Brand Header */}
        <div className="mb-8 flex flex-col items-center sm:items-start text-center sm:text-left">
          <div className="flex items-center gap-4 mb-2">
            <img src="/logo-kruth.png" alt="KRUTH Logo" className="w-16 h-16 object-contain" />
            <div>
              <h1 className="text-3xl font-display font-bold text-[#1A1A1A] tracking-wider uppercase">
                KRUTH AI Studio
              </h1>
              <p className="text-sm text-gray-500 font-thai">
                แพลตฟอร์มผลิตสื่อดิจิทัลอัจฉริยะสำหรับองค์กร
              </p>
            </div>
          </div>
        </div>

        {/* Mode Tabs */}
        <div className="flex flex-wrap sm:flex-nowrap gap-1 p-1 rounded-2xl bg-white border border-gray-200 shadow-sm mb-8">
          <button
            onClick={() => setActiveTab('mode1')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs sm:text-sm font-medium transition-all duration-200 ${
              activeTab === 'mode1'
                ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-md'
                : 'text-gray-500 hover:text-[#1A1A1A] hover:bg-gray-50'
            }`}
          >
            <Film className="w-4 h-4" />
            <span className="font-thai">สร้างวิดีโอ (Video Gen)</span>
          </button>
          
          <button
            onClick={() => setActiveTab('image')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs sm:text-sm font-medium transition-all duration-200 ${
              activeTab === 'image'
                ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-md'
                : 'text-gray-500 hover:text-[#1A1A1A] hover:bg-gray-50'
            }`}
          >
            <ImageIcon className="w-4 h-4" />
            <span className="font-thai">สร้างรูปภาพ (Image Gen)</span>
          </button>

          <button
            onClick={() => setActiveTab('dialogue')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs sm:text-sm font-medium transition-all duration-200 ${
              activeTab === 'dialogue'
                ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-md'
                : 'text-gray-500 hover:text-[#1A1A1A] hover:bg-gray-50'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            <span className="font-thai">สร้างบทสนทนา (Dialogue Gen)</span>
          </button>

          <button
            onClick={() => setActiveTab('mode2')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs sm:text-sm font-medium transition-all duration-200 ${
              activeTab === 'mode2'
                ? 'bg-[#1A1A1A] text-[#D4AF37] shadow-md'
                : 'text-gray-500 hover:text-[#1A1A1A] hover:bg-gray-50'
            } ${!isAdmin ? 'opacity-50 bg-gray-100' : ''}`}
            disabled={!isAdmin}
          >
            <Scan className="w-4 h-4" />
            <span className="font-thai">Face Motion</span>
            {!isAdmin && <Lock className="w-3 h-3" />}
          </button>
        </div>

        {/* Mode Content */}
        <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-lg border border-gray-100">
          {/* Mode Header */}
          <div className="mb-6 pb-5 border-b border-gray-100">
            {activeTab === 'mode1' ? (
              <>
                <h2 className="text-xl font-display font-semibold text-[#1A1A1A] flex items-center gap-2">
                  <Film className="w-5 h-5 text-[#D4AF37]" />
                  ระบบสร้างวิดีโอผู้สอนเสมือนจริง
                </h2>
                <p className="text-sm text-gray-500 mt-2 font-thai leading-relaxed">
                  สร้างสื่อวิดีโอระดับมืออาชีพจากภาพนิ่งและบทพากย์ภาษาไทย ประมวลผลด้วย <span className="font-semibold text-[#D4AF37]">KRUTH Engine</span> ที่รองรับการขยับริมฝีปากอย่างเป็นธรรมชาติ
                </p>
              </>
            ) : activeTab === 'image' ? (
              <>
                <h2 className="text-xl font-display font-semibold text-[#1A1A1A] flex items-center gap-2">
                  <ImageIcon className="w-5 h-5 text-[#D4AF37]" />
                  ระบบสร้างรูปภาพอัจฉริยะ (Image Generator)
                </h2>
                <p className="text-sm text-gray-500 mt-2 font-thai leading-relaxed">
                  สร้างภาพประกอบสื่อการสอนจากข้อความ แปลงสไตล์ภาพ แก้ไขจุดบกพร่อง และขยายขอบเฟรมด้วยโมเดล <span className="font-semibold text-[#D4AF37]">Flux.1 Dev</span> ที่มีความเที่ยงตรงสูง
                </p>
              </>
            ) : activeTab === 'dialogue' ? (
              <>
                <h2 className="text-xl font-display font-semibold text-[#1A1A1A] flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-[#D4AF37]" />
                  ระบบสร้างวิดีโอบทสนทนาหลายตัวละคร (Dialogue Engine)
                </h2>
                <p className="text-sm text-gray-500 mt-2 font-thai leading-relaxed">
                  สร้างวิดีโอบทสนทนาสลับกล้องระหว่างผู้สอนและผู้เรียนเสมือนจริง จัดการลำดับเสียงพากย์ สีหน้าอารมณ์ และต่อวิดีโอรวมเข้าด้วยกันอย่างสมบูรณ์
                </p>
              </>
            ) : (
              <>
                <h2 className="text-xl font-display font-semibold text-[#1A1A1A] flex items-center gap-2">
                  <Scan className="w-5 h-5 text-[#D4AF37]" />
                  ระบบเชื่อมโยงใบหน้า (Admin Only)
                </h2>
                <p className="text-sm text-gray-500 mt-2 font-thai leading-relaxed">
                  ถ่ายทอดอารมณ์และการเคลื่อนไหวระดับสูง สงวนสิทธิ์การใช้งานเฉพาะผู้ดูแลระบบแพลตฟอร์ม KRUTH
                </p>
              </>
            )}
          </div>

          {/* Forms */}
          {activeTab === 'mode1' ? (
            <Mode1Form onVideoGenerated={handleVideoGenerated} />
          ) : activeTab === 'image' ? (
            <ImageTabForm onImageGenerated={handleVideoGenerated} />
          ) : activeTab === 'dialogue' ? (
            <DialogueTabForm />
          ) : isAdmin ? (
            <Mode2Form onVideoGenerated={handleVideoGenerated} />
          ) : (
            <div className="flex flex-col items-center py-16 text-center bg-gray-50 rounded-2xl border border-dashed border-gray-300">
              <Lock className="w-12 h-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-[#1A1A1A] font-thai">
                สำหรับผู้ดูแลระบบเท่านั้น
              </h3>
              <p className="text-sm text-gray-500 mt-2 font-thai">
                ระบบเชื่อมโยงใบหน้าขั้นสูง ถูกจำกัดสิทธิ์เพื่อความปลอดภัยของข้อมูล
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
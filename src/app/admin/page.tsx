'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import Navbar from '@/components/Navbar';
import {
  ShieldCheck,
  Film,
  Scan,
  Users,
  BarChart3,
  DollarSign,
  Trash2,
  RefreshCw,
  Loader2,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/lib/supabase-db';

export default function AdminPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();

  const [mode1Enabled, setMode1Enabled] = useState(true);
  const [mode2Enabled, setMode2Enabled] = useState(true);
  const [stats, setStats] = useState({
    totalGenerations: 0,
    mode1Count: 0,
    mode2Count: 0,
    totalUsers: 0,
    estimatedCost: 0,
  });
  const [loadingStats, setLoadingStats] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [cleanedCount, setCleanedCount] = useState<number | null>(null);

  useEffect(() => {
    if (!loading && (!user || !isAdmin)) router.push('/dashboard');
  }, [user, isAdmin, loading, router]);

  useEffect(() => {
    loadStats();
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('key, value');
      if (error) throw error;

      if (data) {
        const mode1 = data.find((item: any) => item.key === 'mode1_enabled');
        const mode2 = data.find((item: any) => item.key === 'mode2_enabled');
        setMode1Enabled(mode1 ? mode1.value === 'true' : true);
        setMode2Enabled(mode2 ? mode2.value === 'true' : true);
      }
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  };

  const saveConfig = async (field: string, value: boolean) => {
    try {
      const key = field === 'mode1_enabled' ? 'mode1_enabled' : 'mode2_enabled';
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key,
          value: String(value),
          description: `Master switch for ${field}`,
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      // Get generations
      const { data: gens, error: gensError } = await supabase
        .from('generations')
        .select('metadata');
      if (gensError) throw gensError;

      let mode1 = 0, mode2 = 0;
      gens?.forEach((d: any) => {
        if (d.metadata?.mode === 'text-to-video') mode1++;
        else mode2++;
      });

      // Count users from whitelist table
      const { count: totalUsers, error: usersError } = await supabase
        .from('whitelist')
        .select('*', { count: 'exact', head: true });
      if (usersError) throw usersError;

      const estimatedCost = mode1 * 0.15 + mode2 * 0.10;

      setStats({
        totalGenerations: gens?.length || 0,
        mode1Count: mode1,
        mode2Count: mode2,
        totalUsers: totalUsers || 0,
        estimatedCost,
      });
    } catch (err) {
      console.error('Failed to load stats:', err);
    } finally {
      setLoadingStats(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const res = await fetch('/api/cleanup', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setCleanedCount(data.deleted_count);
      } else {
        throw new Error(data.error || 'Failed to cleanup');
      }
      await loadStats();
    } catch (err) {
      console.error('Cleanup failed:', err);
    } finally {
      setCleaning(false);
    }
  };

  if (loading || !user || !isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-warm/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-accent-warm" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold text-text-primary tracking-tight">
              Admin Dashboard
            </h1>
            <p className="text-sm text-text-secondary font-thai">จัดการระบบและติดตามการใช้งาน</p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'วิดีโอทั้งหมด', value: stats.totalGenerations, icon: Film, color: 'text-accent-primary' },
            { label: 'Text → Video', value: stats.mode1Count, icon: Film, color: 'text-accent-primary' },
            { label: 'Face Motion', value: stats.mode2Count, icon: Scan, color: 'text-accent-warm' },
            { label: 'ผู้ใช้ทั้งหมด', value: stats.totalUsers, icon: Users, color: 'text-accent-success' },
          ].map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div key={i} className="glow-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${stat.color}`} />
                  <span className="text-xs text-text-muted font-thai">{stat.label}</span>
                </div>
                <p className="text-2xl font-display font-bold text-text-primary">
                  {loadingStats ? '—' : stat.value}
                </p>
              </div>
            );
          })}
        </div>

        {/* Estimated Cost */}
        <div className="glow-card p-5 mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent-success/10 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-accent-success" />
              </div>
              <div>
                <p className="text-sm text-text-secondary font-thai">ค่าใช้จ่ายโดยประมาณ</p>
                <p className="text-xl font-display font-bold text-text-primary">
                  ${loadingStats ? '—' : stats.estimatedCost.toFixed(2)}
                </p>
              </div>
            </div>
            <button
              onClick={loadStats}
              className="btn-ghost flex items-center gap-2 text-sm"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              รีเฟรช
            </button>
          </div>
        </div>

        {/* Mode Controls */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-5">
            ควบคุมโหมด (Master Switches)
          </h2>
          <div className="space-y-4">
            {/* Mode 1 Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-accent-primary" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    Mode 1: Text → Video (Wan 2.5)
                  </p>
                  <p className="text-xs text-text-muted font-thai">สร้างวิดีโอจากบทพากย์และรูปภาพ</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setMode1Enabled(!mode1Enabled);
                  saveConfig('mode1_enabled', !mode1Enabled);
                }}
                className="text-2xl"
              >
                {mode1Enabled ? (
                  <ToggleRight className="w-10 h-10 text-accent-success" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-text-muted" />
                )}
              </button>
            </div>

            {/* Mode 2 Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Scan className="w-5 h-5 text-accent-warm" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    Mode 2: Face Motion (LivePortrait / Hallo)
                  </p>
                  <p className="text-xs text-text-muted font-thai">ถ่ายทอดการเคลื่อนไหวใบหน้า</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setMode2Enabled(!mode2Enabled);
                  saveConfig('mode2_enabled', !mode2Enabled);
                }}
                className="text-2xl"
              >
                {mode2Enabled ? (
                  <ToggleRight className="w-10 h-10 text-accent-success" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-text-muted" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Data Cleanup */}
        <div className="glow-card p-6">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-3">
            ล้างข้อมูลหมดอายุ
          </h2>
          <p className="text-sm text-text-muted mb-4 font-thai">
            ลบวิดีโอและข้อมูลที่หมดอายุ (เกิน 24 ชม.) จาก Firestore และ Storage
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="btn-ghost flex items-center gap-2 text-sm border-accent-danger/20 text-accent-danger hover:bg-accent-danger/10 hover:border-accent-danger/30"
            >
              {cleaning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              {cleaning ? 'กำลังล้างข้อมูล...' : 'ล้างข้อมูลหมดอายุ'}
            </button>
            {cleanedCount !== null && (
              <span className="text-sm text-accent-success font-thai">
                ลบแล้ว {cleanedCount} รายการ
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

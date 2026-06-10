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
  X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase-db';

export default function AdminPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();

  const [mode1Enabled, setMode1Enabled] = useState(true);
  const [mode2Enabled, setMode2Enabled] = useState(true);
  const [safetyFilterDisabled, setSafetyFilterDisabled] = useState(false);
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

  // Whitelist, Quota and Provider Switch states
  const [whitelist, setWhitelist] = useState<any[]>([]);
  const [loadingWhitelist, setLoadingWhitelist] = useState(true);
  const [providerSetting, setProviderSetting] = useState('siliconflow');

  // Whitelist Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState<'add' | 'edit'>('add');
  const [selectedUser, setSelectedUser] = useState<any>(null);
  
  // Form fields
  const [emailField, setEmailField] = useState('');
  const [nameField, setNameField] = useState('');
  const [expiryField, setExpiryField] = useState('');
  const [limitField, setLimitField] = useState(10);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && (!user || !isAdmin)) router.push('/dashboard');
  }, [user, isAdmin, loading, router]);

  useEffect(() => {
    loadStats();
    loadConfig();
    loadWhitelist();
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
        const provider = data.find((item: any) => item.key === 'open_source_provider');
        const safetyFilter = data.find((item: any) => item.key === 'safety_filter_disabled');
        setMode1Enabled(mode1 ? mode1.value === 'true' : true);
        setMode2Enabled(mode2 ? mode2.value === 'true' : true);
        setProviderSetting(provider ? provider.value : 'siliconflow');
        setSafetyFilterDisabled(safetyFilter ? safetyFilter.value === 'true' : false);
      }
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  };

  const saveConfig = async (key: string, value: boolean) => {
    try {
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key,
          value: String(value),
          description: `Setting for ${key}`,
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  const saveProviderConfig = async (value: string) => {
    try {
      setProviderSetting(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'open_source_provider',
          value,
          description: 'Provider for Wan 2.5, LivePortrait, and standard Flux.1',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save provider config:', err);
    }
  };

  const loadWhitelist = async () => {
    setLoadingWhitelist(true);
    try {
      const { data: whitelistData, error } = await supabase
        .from('whitelist')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Fetch today's generations count per user
      const localStartOfDay = new Date();
      localStartOfDay.setHours(0, 0, 0, 0);
      const { data: todayGens } = await supabase
        .from('generations')
        .select('profiles!inner(email)')
        .gte('created_at', localStartOfDay.toISOString());

      const usageMap: Record<string, number> = {};
      todayGens?.forEach((gen: any) => {
        const email = gen.profiles?.email?.toLowerCase();
        if (email) {
          usageMap[email] = (usageMap[email] || 0) + 1;
        }
      });

      const processedWhitelist = (whitelistData || []).map((item: any) => ({
        ...item,
        used_today: usageMap[item.email.toLowerCase()] || 0
      }));

      setWhitelist(processedWhitelist);
    } catch (err) {
      console.error('Failed to load whitelist:', err);
    } finally {
      setLoadingWhitelist(false);
    }
  };

  const getTimeLeft = (expiryDateStr: string | null) => {
    if (!expiryDateStr) return 'ถาวร (Unlimited)';
    const expiry = new Date(expiryDateStr);
    const diffMs = expiry.getTime() - Date.now();
    if (diffMs <= 0) return 'หมดอายุแล้ว (Expired)';

    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (diffDays > 0) {
      return `เหลืออีก ${diffDays} วัน ${diffHours} ชม.`;
    }
    return `เหลืออีก ${diffHours} ชม.`;
  };

  const openAddModal = () => {
    setModalType('add');
    setEmailField('');
    setNameField('');
    setExpiryField('');
    setLimitField(10);
    setActionError(null);
    setShowModal(true);
  };

  const openEditModal = (user: any) => {
    setModalType('edit');
    setSelectedUser(user);
    setEmailField(user.email);
    setNameField(user.display_name || '');
    const dateStr = user.expires_at ? new Date(user.expires_at).toISOString().split('T')[0] : '';
    setExpiryField(dateStr);
    setLimitField(user.generation_limit || 10);
    setActionError(null);
    setShowModal(true);
  };

  const handleSaveWhitelist = async () => {
    setActionError(null);
    if (!emailField.trim()) {
      setActionError('กรุณากรอกอีเมล');
      return;
    }

    try {
      const payload: any = {
        email: emailField.trim().toLowerCase(),
        display_name: nameField.trim() || null,
        expires_at: expiryField ? new Date(expiryField).toISOString() : null,
        generation_limit: limitField,
      };

      const { error } = await supabase
        .from('whitelist')
        .upsert(payload);

      if (error) throw error;
      setShowModal(false);
      await loadWhitelist();
      await loadStats();
    } catch (err: any) {
      setActionError(err.message || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
    }
  };

  const handleDeleteWhitelist = async (email: string) => {
    if (!confirm(`คุณต้องการลบสิทธิ์ของ ${email} ใช่หรือไม่?`)) return;
    try {
      const { error } = await supabase
        .from('whitelist')
        .delete()
        .eq('email', email);
      if (error) throw error;
      await loadWhitelist();
      await loadStats();
    } catch (err) {
      console.error('Failed to delete whitelist user:', err);
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

            {/* Safety Filter Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-accent-danger" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ปิดระบบกรองเนื้อหาความปลอดภัย (Disable Safety Filter / NSFW)
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    อนุญาตการสร้างคลิปโดยปิดระบบกรองความปลอดภัย (มีผลทั่วทั้งระบบสำหรับโมเดลที่รองรับ)
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  const newVal = !safetyFilterDisabled;
                  setSafetyFilterDisabled(newVal);
                  saveConfig('safety_filter_disabled', newVal);
                }}
                className="text-2xl"
              >
                {safetyFilterDisabled ? (
                  <ToggleRight className="w-10 h-10 text-accent-danger" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-text-muted" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Provider Settings Switch */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-5 font-thai">
            สลับผู้ให้บริการโมเดล Open-source (Provider Switch)
          </h2>
          <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
            <div className="flex items-center gap-3">
              <RefreshCw className="w-5 h-5 text-accent-primary" />
              <div>
                <p className="text-sm font-medium text-text-primary font-thai">
                  โมเดลระดับสากลหลัก (Wan 2.5, LivePortrait, Flux.1)
                </p>
                <p className="text-xs text-text-muted font-thai">
                  สลับ API ปลายทางแบบเรียลไทม์ระหว่าง Fal.ai และ SiliconFlow
                </p>
              </div>
            </div>
            <div className="flex gap-2 bg-[#1A1A1A] p-1 rounded-xl border border-white/5">
              <button
                onClick={() => saveProviderConfig('fal')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                  providerSetting === 'fal'
                    ? 'bg-[#D4AF37] text-black shadow-md'
                    : 'text-text-muted hover:text-white'
                }`}
              >
                Fal.ai
              </button>
              <button
                onClick={() => saveProviderConfig('siliconflow')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                  providerSetting === 'siliconflow'
                    ? 'bg-[#D4AF37] text-black shadow-md'
                    : 'text-text-muted hover:text-white'
                }`}
              >
                SiliconFlow
              </button>
            </div>
          </div>
        </div>

        {/* Whitelist Management */}
        <div className="glow-card p-6 mb-8">
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-lg font-display font-semibold text-text-primary font-thai">
              รายชื่อผู้ใช้ที่ได้รับสิทธิ์สร้างคลิป (Whitelist & Daily Limits)
            </h2>
            <button
              onClick={openAddModal}
              className="btn-ghost text-xs bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] hover:bg-[#D4AF37]/20 px-3 py-1.5 rounded-xl font-thai font-bold"
            >
              + เพิ่มผู้ใช้ใหม่
            </button>
          </div>

          <div className="overflow-x-auto">
            {loadingWhitelist ? (
              <div className="py-12 flex justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-[#D4AF37]" />
              </div>
            ) : whitelist.length === 0 ? (
              <div className="py-12 text-center text-sm text-text-muted font-thai">
                ไม่มีรายชื่อผู้ใช้ในระบบ Whitelist
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-text-muted text-xs">
                    <th className="py-3 px-4 font-thai">อีเมลผู้ใช้ (Email)</th>
                    <th className="py-3 px-4 font-thai">ชื่อผู้ใช้ (Display Name)</th>
                    <th className="py-3 px-4 font-thai">วันหมดอายุ (Expires At)</th>
                    <th className="py-3 px-4 font-thai">ระยะเวลาคงเหลือ (Time Left)</th>
                    <th className="py-3 px-4 text-center font-thai">โควตาที่ใช้ (Usage / Limit)</th>
                    <th className="py-3 px-4 text-right font-thai">การจัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {whitelist.map((item) => {
                    const timeLeft = getTimeLeft(item.expires_at);
                    const isExpired = timeLeft === 'หมดอายุแล้ว (Expired)';
                    const usedToday = item.used_today || 0;
                    const limit = item.generation_limit || 0;
                    const remaining = Math.max(0, limit - usedToday);
                    
                    return (
                      <tr key={item.email} className="hover:bg-white/5 transition-colors">
                        <td className="py-3.5 px-4 font-medium font-thai truncate max-w-[180px]">{item.email}</td>
                        <td className="py-3.5 px-4 font-thai">{item.display_name || '—'}</td>
                        <td className="py-3.5 px-4 text-xs font-mono">
                          {item.expires_at ? new Date(item.expires_at).toLocaleDateString('th-TH') : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          <span className={`px-2 py-0.5 rounded font-thai font-medium ${
                            isExpired 
                              ? 'bg-accent-danger/10 text-accent-danger border border-accent-danger/20' 
                              : (timeLeft === 'ถาวร (Unlimited)' ? 'bg-accent-success/10 text-accent-success border border-accent-success/20' : 'bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/20')
                          }`}>
                            {timeLeft}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono">
                          <span className={`${remaining === 0 ? 'text-accent-danger font-bold' : 'text-text-primary'}`}>
                            {usedToday} / {limit}
                          </span>
                          <span className="text-xs text-text-muted font-thai ml-1">
                            (เหลือ {remaining})
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => openEditModal(item)}
                              className="text-xs text-text-muted hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-colors font-thai"
                            >
                              แก้ไข
                            </button>
                            <button
                              onClick={() => handleDeleteWhitelist(item.email)}
                              className="text-xs text-accent-danger hover:text-accent-danger-hover px-2 py-1 rounded hover:bg-accent-danger/5 transition-colors font-thai"
                            >
                              ลบ
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Data Cleanup */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-3 font-thai">
            ล้างข้อมูลหมดอายุ
          </h2>
          <p className="text-sm text-text-muted mb-4 font-thai">
            ลบวิดีโอและข้อมูลที่หมดอายุ (เกิน 24 ชม.) จาก Firestore และ Storage
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="btn-ghost flex items-center gap-2 text-sm border-accent-danger/20 text-accent-danger hover:bg-accent-danger/10 hover:border-accent-danger/30 font-thai font-bold"
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

      {/* Whitelist Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in font-thai">
          <div className="bg-[#1C1C1E] border border-white/10 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-scale-up">
            <div className="bg-[#2C2C2E] p-4 flex items-center justify-between border-b border-white/5">
              <h3 className="text-base font-bold text-white font-thai">
                {modalType === 'add' ? '➕ เพิ่มบัญชีผู้ใช้ใหม่' : '✏️ แก้ไขข้อมูลบัญชีผู้ใช้'}
              </h3>
              <button 
                onClick={() => setShowModal(false)}
                className="text-text-muted hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {actionError && (
                <div className="p-3 rounded-xl bg-accent-danger/10 border border-accent-danger/25 text-xs text-accent-danger">
                  ⚠️ {actionError}
                </div>
              )}

              {/* Email */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-text-secondary uppercase font-thai">อีเมลผู้ใช้ (Email) *</label>
                <input
                  type="email"
                  disabled={modalType === 'edit'}
                  value={emailField}
                  onChange={(e) => setEmailField(e.target.value)}
                  placeholder="name@email.com"
                  className="w-full bg-[#2C2C2E] border border-white/10 p-3 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all disabled:opacity-50"
                />
              </div>

              {/* Name */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-text-secondary uppercase font-thai">ชื่อผู้แสดงผล (Display Name)</label>
                <input
                  type="text"
                  value={nameField}
                  onChange={(e) => setNameField(e.target.value)}
                  placeholder="เช่น ครูสมศรี"
                  className="w-full bg-[#2C2C2E] border border-white/10 p-3 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all"
                />
              </div>

              {/* Generation Limit */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-text-secondary uppercase font-thai">จำนวนคลิปที่อนุญาตให้สร้างต่อวัน (Daily Limit)</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={limitField}
                  onChange={(e) => setLimitField(parseInt(e.target.value, 10) || 10)}
                  placeholder="10"
                  className="w-full bg-[#2C2C2E] border border-white/10 p-3 rounded-xl text-sm text-white outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all font-mono"
                />
              </div>

              {/* Expiry Date */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-text-secondary uppercase font-thai">วันหมดอายุสิทธิ์การใช้งาน (Leave empty for permanent)</label>
                <input
                  type="date"
                  value={expiryField}
                  onChange={(e) => setExpiryField(e.target.value)}
                  className="w-full bg-[#2C2C2E] border border-white/10 p-3 rounded-xl text-sm text-white outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all font-mono cursor-pointer"
                />
              </div>
            </div>

            <div className="bg-[#2C2C2E]/50 p-4 border-t border-white/5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-text-muted font-bold hover:bg-white/5 transition-all font-thai"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleSaveWhitelist}
                className="flex-1 py-2.5 rounded-xl bg-[#D4AF37] text-black font-bold hover:bg-[#D4AF37]/90 transition-all shadow-md font-thai"
              >
                บันทึกสิทธิ์
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

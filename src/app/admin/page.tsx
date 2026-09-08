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
  Volume2,
  VolumeX,
} from 'lucide-react';
import { supabase } from '@/lib/supabase-db';
import { PACKAGES } from '@/lib/credits/packages';

export default function AdminPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();

  const [mode1Enabled, setMode1Enabled] = useState(true);
  const [mode2Enabled, setMode2Enabled] = useState(true);
  const [safetyFilterDisabled, setSafetyFilterDisabled] = useState(false);
  // Character registry queue
  const [registry, setRegistry] = useState<any[]>([]);
  const [regStatus, setRegStatus] = useState<'under_review' | 'draft' | 'active' | 'disabled'>('under_review');
  const [regBusy, setRegBusy] = useState(false);
  const loadRegistry = async (status = regStatus) => { const j = await fetch(`/api/admin/registry?email=${encodeURIComponent(user?.email || '')}&status=${status}`).then((r) => r.json()).catch(() => null); if (j?.success) setRegistry(j.records); };
  const regAct = async (id: string, to: string) => { const note = prompt('เหตุผล (บันทึกใน audit)', '') ?? ''; setRegBusy(true); try { const j = await fetch('/api/admin/registry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: user?.email, action: 'transition', character_id: id, to, note }) }).then((r) => r.json()); if (!j.success) alert(j.error); await loadRegistry(); } finally { setRegBusy(false); } };
  useEffect(() => { if (user?.email) loadRegistry(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.email]);
  // Moderation queue + audit viewer
  const [reports, setReports] = useState<any[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [auditDate, setAuditDate] = useState(new Date().toISOString().slice(0, 10));
  const [modBusy, setModBusy] = useState(false);
  const loadReports = async () => { const j = await fetch(`/api/admin/moderation?email=${encodeURIComponent(user?.email || '')}&status=open`).then((r) => r.json()).catch(() => null); if (j?.success) setReports(j.reports); };
  const loadAudit = async () => { const j = await fetch(`/api/admin/moderation?email=${encodeURIComponent(user?.email || '')}&audit=${auditDate}`).then((r) => r.json()).catch(() => null); if (j?.success) setAuditEvents(j.events); };
  useEffect(() => { if (user?.email) loadReports(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.email]);
  // Credit packages (direction pivot)
  const [pkgEmail, setPkgEmail] = useState('');
  const [pkgId, setPkgId] = useState('creator');
  const [pkgBusy, setPkgBusy] = useState(false);
  const [pkgResult, setPkgResult] = useState('');
  // Phase 4: billed prices — a Fal usage export sets the registry's rates
  const [billResult, setBillResult] = useState<any>(null);
  const [billBusy, setBillBusy] = useState(false);
  const [billMapping, setBillMapping] = useState<any[]>([]);
  const importBill = async (file: File) => {
    setBillBusy(true);
    setBillResult(null);
    try {
      const csv = await file.text();
      const res = await fetch('/api/admin/bill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: user?.email, csv, source: file.name }) });
      const j = await res.json();
      setBillResult(j);
      if (j.success) {
        const m = await fetch(`/api/admin/bill?email=${encodeURIComponent(user?.email || '')}`).then((r) => r.json());
        if (m.success) setBillMapping(m.mapping.filter((x: any) => x.billed));
      }
    } catch (e: any) {
      setBillResult({ success: false, error: e.message });
    } finally {
      setBillBusy(false);
    }
  };
  const [wanResolution, setWanResolution] = useState('720p');
  const [klingResolution, setKlingResolution] = useState('720p');
  const [grokResolution, setGrokResolution] = useState('720p');
  const [seedanceResolution, setSeedanceResolution] = useState('720p');
  const [klingAudioEnabled, setKlingAudioEnabled] = useState(false);
  // Give clips without dialogue a soundtrack: engines that can score themselves do,
  // the rest get one added afterwards (costs ~2 extra credits per clip).
  const [ambientAudioEnabled, setAmbientAudioEnabled] = useState(false);
  // Allow premium engines (Veo 3 / Sora 2) inside the automated long-video mode. Off by default: a
  // 2-minute auto video is ~15 clips, which costs roughly 6-9x more on premium engines.
  const [automationPremiumEnabled, setAutomationPremiumEnabled] = useState(false);
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
  }, []);

  // The role lookup inside needs to say who is asking, so wait until the login resolves
  useEffect(() => {
    if (user?.email) loadWhitelist();
  }, [user?.email]);

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
        const wanRes = data.find((item: any) => item.key === 'wan_resolution');
        const klingRes = data.find((item: any) => item.key === 'kling_resolution');
        const grokRes = data.find((item: any) => item.key === 'grok_resolution');
        const seedanceRes = data.find((item: any) => item.key === 'seedance_resolution');
        const klingAudio = data.find((item: any) => item.key === 'kling_audio_enabled');
        const ambientAudio = data.find((item: any) => item.key === 'ambient_audio_enabled');
        const autoPremium = data.find((item: any) => item.key === 'automation_premium_enabled');

        setMode1Enabled(mode1 ? mode1.value === 'true' : true);
        setMode2Enabled(mode2 ? mode2.value === 'true' : true);
        setProviderSetting(provider ? provider.value : 'siliconflow');
        setSafetyFilterDisabled(safetyFilter ? safetyFilter.value === 'true' : false);
        setWanResolution(wanRes ? wanRes.value : '720p');
        setKlingResolution(klingRes ? klingRes.value : '720p');
        setGrokResolution(grokRes ? grokRes.value : '720p');
        setSeedanceResolution(seedanceRes ? seedanceRes.value : '720p');
        setKlingAudioEnabled(klingAudio ? klingAudio.value === 'true' : false);
        setAmbientAudioEnabled(ambientAudio ? ambientAudio.value === 'true' : false);
        setAutomationPremiumEnabled(autoPremium ? autoPremium.value === 'true' : false);
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

  const saveWanResolution = async (value: string) => {
    try {
      setWanResolution(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'wan_resolution',
          value,
          description: 'Resolution for Wan 2.2/2.5 on Fal.ai (480p or 720p)',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save wan resolution:', err);
    }
  };

  const saveKlingResolution = async (value: string) => {
    try {
      setKlingResolution(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'kling_resolution',
          value,
          description: 'Resolution for Kling 2.6 Pro (720p Standard or 1080p Pro)',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save kling resolution:', err);
    }
  };

  const saveGrokResolution = async (value: string) => {
    try {
      setGrokResolution(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'grok_resolution',
          value,
          description: 'Resolution for Grok Imagine Video (480p or 720p)',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save grok resolution:', err);
    }
  };

  const saveSeedanceResolution = async (value: string) => {
    try {
      setSeedanceResolution(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'seedance_resolution',
          value,
          description: 'Resolution for Seedance (480p, 720p or 1080p)',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save seedance resolution:', err);
    }
  };

  const saveKlingAudioEnabled = async (value: boolean) => {
    try {
      setKlingAudioEnabled(value);
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'kling_audio_enabled',
          value: String(value),
          description: 'Toggle Sound Effects & Ambient Audio for Kling 2.6 Pro',
          updated_at: new Date().toISOString()
        });
      if (error) throw error;
    } catch (err) {
      console.error('Failed to save kling audio enabled:', err);
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

      // Who holds the admin role lives in profiles, behind the server — the anon key
      // this page runs on cannot read it
      let adminEmails: string[] = [];
      try {
        const roleRes = await fetch(`/api/admin/role?email=${encodeURIComponent(user?.email || '')}`);
        const roleJson = await roleRes.json();
        if (roleJson.success) adminEmails = roleJson.admin_emails || [];
      } catch (e) {
        console.warn('Failed to load admin roles:', e);
      }

      const processedWhitelist = (whitelistData || []).map((item: any) => ({
        ...item,
        used_today: usageMap[item.email.toLowerCase()] || 0,
        is_admin_role: adminEmails.includes(item.email.toLowerCase()) || item.email.toLowerCase() === 'whootthira@gmail.com'
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
    setLimitField(100);
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
    setLimitField((user.generation_limit || 0) / 10);
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
        generation_limit: Math.round(limitField * 10),
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

  const handleToggleAdmin = async (email: string, makeAdmin: boolean) => {
    const q = makeAdmin
      ? `ตั้ง ${email} เป็นแอดมิน? จะเห็นและจัดการข้อมูลของผู้ใช้ทุกคนได้`
      : `ถอดสิทธิ์แอดมินของ ${email}?`;
    if (!confirm(q)) return;
    try {
      const res = await fetch('/api/admin/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: user?.email, target_email: email, make_admin: makeAdmin })
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || 'เปลี่ยนสิทธิ์ไม่สำเร็จ');
        return;
      }
      await loadWhitelist();
    } catch (err: any) {
      alert(err?.message || 'เปลี่ยนสิทธิ์ไม่สำเร็จ');
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

            {/* Automation: premium engines toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-[#D4AF37]" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    โหมดอัตโนมัติ: อนุญาตโมเดลพรีเมียม (Veo 3 / Sora 2)
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    ปิดไว้เพื่อความประหยัด — คลิปยาว 2 นาทีด้วยโมเดลพรีเมียมมีค่าใช้จ่ายสูงกว่าราว 6–9 เท่า
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setAutomationPremiumEnabled(!automationPremiumEnabled);
                  saveConfig('automation_premium_enabled', !automationPremiumEnabled);
                }}
                className="text-2xl"
              >
                {automationPremiumEnabled ? (
                  <ToggleRight className="w-10 h-10 text-accent-success" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-text-muted" />
                )}
              </button>
            </div>

            {/* Ambient sound for clips without dialogue */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Volume2 className="w-5 h-5 text-[#D4AF37]" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    เสียงบรรยากาศสำหรับคลิปที่ไม่มีบทพูด
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    โมเดลที่ทำเสียงเองได้ (Veo 3 / Kling 1080p) จะเปิดใช้ ส่วนโมเดลอื่นจะใส่เสียงให้ตรงภาพหลังสร้างเสร็จ (+2 เครดิต/คลิป)
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setAmbientAudioEnabled(!ambientAudioEnabled);
                  saveConfig('ambient_audio_enabled', !ambientAudioEnabled);
                }}
                className="text-2xl"
              >
                {ambientAudioEnabled ? (
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

        {/* Character registry review queue (Content Policy §3–4) */}
        <div className="glow-card p-6 mb-8">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-display font-semibold text-text-primary font-thai">ทะเบียนตัวละคร — คิวตรวจ</h2>
            <div className="flex items-center gap-2 text-xs font-thai">
              {(['under_review', 'draft', 'active', 'disabled'] as const).map((s) => <button key={s} type="button" onClick={() => { setRegStatus(s); loadRegistry(s); }} className={`px-3 py-1.5 rounded-lg border ${regStatus === s ? 'bg-[#D4AF37] text-black border-[#D4AF37]' : 'bg-[#1C1C1E] border-white/10 text-white'}`}>{({ under_review: 'รอตรวจ', draft: 'ร่าง', active: 'ผ่านตรวจ', disabled: 'ระงับ' } as any)[s]}</button>)}
            </div>
          </div>
          <p className="text-xs text-text-muted font-thai mb-3">แหล่งที่มา: generated = สร้างในระบบ · uploaded = ภาพคนจริง (ต้องมี consent ก่อนอนุมัติ) · trained = LoRA · ตัวละครที่ "ระงับ" ใช้สร้างงานไม่ได้ทันที · ตั้ง REGISTRY_ENFORCE=1 เพื่อให้เฉพาะ "ผ่านตรวจ" ใช้ได้</p>
          {registry.length === 0 ? <p className="text-xs text-text-muted font-thai">ไม่มีรายการในสถานะนี้</p> : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {registry.map((r) => (
                <div key={r.character_id} className="rounded-xl border border-white/10 bg-surface-2/30 p-3 text-xs font-thai space-y-2">
                  <div className="flex items-center gap-2">
                    {r.assets?.[0]?.url && <img src={r.assets[0].url} alt="" className="w-12 h-12 rounded-lg object-cover" />}
                    <div className="flex-1">
                      <p className="text-text-primary font-semibold">{r.name} <span className="text-text-muted font-normal">· {r.source} · {r.owner_email}</span></p>
                      <p className="text-text-muted">{r.assets?.length || 0} ภาพ{r.assets?.[0]?.sha256 ? ` · sha256 ${r.assets[0].sha256.slice(0, 12)}…` : ''}{r.consent_id ? ` · consent ${r.consent_id}` : r.source === 'uploaded' ? ' · ไม่มี consent' : ''}{r.lora?.status ? ` · LoRA ${r.lora.status}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.review.status !== 'active' && <button type="button" disabled={regBusy} onClick={() => regAct(r.character_id, 'active')} className="px-3 py-1 rounded-lg border border-green-500/40 text-green-300 disabled:opacity-40">อนุมัติ (active)</button>}
                    {r.review.status === 'under_review' && <button type="button" disabled={regBusy} onClick={() => regAct(r.character_id, 'draft')} className="px-3 py-1 rounded-lg border border-white/10 text-white disabled:opacity-40">ส่งกลับแก้</button>}
                    {r.review.status !== 'disabled' && <button type="button" disabled={regBusy} onClick={() => regAct(r.character_id, 'disabled')} className="px-3 py-1 rounded-lg border border-accent-danger/40 text-accent-danger disabled:opacity-40">ระงับ</button>}
                    {r.review.status === 'disabled' && <button type="button" disabled={regBusy} onClick={() => regAct(r.character_id, 'under_review')} className="px-3 py-1 rounded-lg border border-white/10 text-white disabled:opacity-40">เปิดตรวจใหม่</button>}
                  </div>
                  {r.review.history?.[0] && <p className="text-text-muted">ล่าสุด: {r.review.history[0].from} → {r.review.history[0].to} โดย {r.review.history[0].by}{r.review.history[0].note ? ` — ${r.review.history[0].note}` : ''}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Moderation queue + audit (Content Policy §5–6) */}
        <div className="glow-card p-6 mb-8">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-display font-semibold text-text-primary font-thai">คิวรายงานและ audit log</h2>
            <div className="flex items-center gap-2 text-xs font-thai">
              <button type="button" onClick={loadReports} className="px-3 py-1.5 rounded-lg bg-[#1C1C1E] border border-white/10 text-white">รีเฟรชรายงาน</button>
              <input type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)} className="px-2 py-1.5 rounded-lg bg-[#1C1C1E] border border-white/10 text-white" />
              <button type="button" onClick={loadAudit} className="px-3 py-1.5 rounded-lg bg-[#1C1C1E] border border-white/10 text-white">ดู audit วันนี้</button>
            </div>
          </div>
          <p className="text-xs text-text-muted font-thai mb-3">นโยบายฉบับเต็ม: docs/CONTENT_POLICY.md · ผู้ตรวจ (reviewer) และผู้ดูแลตัดสินได้ ทุกคำตัดสินเข้า audit log</p>
          {reports.length === 0 ? <p className="text-xs text-text-muted font-thai">ไม่มีรายงานที่เปิดอยู่</p> : (
            <div className="space-y-2">
              {reports.map((r) => (
                <div key={r.id} className="rounded-xl border border-white/10 bg-surface-2/30 p-3 text-xs font-thai space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-text-primary">
                    <span className="px-2 py-0.5 rounded-md bg-accent-danger/20 text-accent-danger">{({ my_likeness: 'ภาพลักษณ์ของฉัน', minor: 'ผู้เยาว์', sexual_violence: 'ความรุนแรงทางเพศ', impersonation: 'แอบอ้าง', copyright: 'ลิขสิทธิ์', other: 'อื่นๆ' } as any)[r.reason] || r.reason}</span>
                    <span>โดย {r.reporter}</span><span className="text-text-muted">{new Date(r.at).toLocaleString('th-TH')}</span>
                    {r.owner_email && <span className="text-text-muted">เจ้าของ: {r.owner_email}</span>}
                    {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="text-[#D4AF37] underline">เปิดผลงาน</a>}
                  </div>
                  {r.note && <p className="text-text-muted">{r.note}</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {([['dismissed', 'ยกคำร้อง'], ['removed', 'ลบผลงาน'], ['user_suspended', 'ลบ + ระงับบัญชี']] as const).map(([d, label]) => (
                      <button key={d} type="button" disabled={modBusy} onClick={async () => { const note = prompt('เหตุผลการตัดสิน (บันทึกใน audit)', '') ?? ''; if (!note && d !== 'dismissed') return; setModBusy(true); try { const j = await fetch('/api/admin/moderation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: user?.email, action: 'decide', report_id: r.id, decision: d, note }) }).then((x) => x.json()); if (!j.success) alert(j.error); await loadReports(); } finally { setModBusy(false); } }} className={`px-3 py-1 rounded-lg border ${d === 'dismissed' ? 'border-white/10 text-white' : 'border-accent-danger/40 text-accent-danger'} disabled:opacity-40`}>{label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {auditEvents.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[11px] font-thai">
                <thead><tr className="text-text-muted text-left"><th className="py-1 pr-3">เวลา</th><th className="pr-3">เหตุการณ์</th><th className="pr-3">ผู้ทำ</th><th className="pr-3">เป้าหมาย</th><th>รายละเอียด</th></tr></thead>
                <tbody>{auditEvents.map((e) => <tr key={e.id} className="border-t border-white/5 text-text-primary"><td className="py-1 pr-3 whitespace-nowrap">{new Date(e.at).toLocaleTimeString('th-TH')}</td><td className="pr-3 font-mono">{e.kind}</td><td className="pr-3">{e.actor}</td><td className="pr-3 font-mono">{(e.target || '').slice(0, 40)}</td><td className="text-text-muted">{JSON.stringify(e.detail || {}).slice(0, 160)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>

        {/* Credit packages by tier (direction pivot) */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-2 font-thai">แพ็กเกจเครดิตแยกระดับ (Starter / Creator / Studio / Production)</h2>
          <p className="text-xs text-text-muted font-thai mb-4">ให้แพ็กเกจ = เพิ่มเครดิตตามแพ็กเกจและตั้งระดับโมเดลที่บัญชีใช้ได้ (economy / pro / ultra) · O3 edit และ Film Mode ต้อง ultra, ตัวละคร Motion Control ต้อง pro · บัญชีเดิมที่ไม่เคยรับแพ็กเกจยังใช้ได้ทุกระดับ</p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            {PACKAGES.map((p) => (
              <div key={p.id} className="rounded-xl border border-white/10 bg-surface-2/30 p-3 text-xs font-thai">
                <p className="text-sm font-bold text-text-primary">{p.label} <span className="text-[#D4AF37]">฿{p.price_thb.toLocaleString()}</span></p>
                <p className="text-text-primary">{p.credits.toLocaleString()} เครดิต · ระดับ {p.max_tier} · ฿{(p.price_thb / p.credits).toFixed(2)}/เครดิต</p>
                <p className="text-text-muted mt-1">{p.blurb}</p>
                <ul className="text-text-muted mt-1 list-disc pl-4">{p.examples.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-thai">
            <input value={pkgEmail} onChange={(e) => setPkgEmail(e.target.value)} placeholder="อีเมลผู้ใช้ (ต้องอยู่ในรายชื่อแล้ว)" className="px-3 py-2 rounded-lg bg-[#1C1C1E] border border-white/10 text-white w-64" />
            <select value={pkgId} onChange={(e) => setPkgId(e.target.value)} className="px-2 py-2 rounded-lg bg-[#1C1C1E] border border-white/10 text-white">{PACKAGES.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.credits} เครดิต</option>)}</select>
            <button type="button" disabled={pkgBusy || !pkgEmail} onClick={async () => { setPkgBusy(true); setPkgResult(''); try { const r = await fetch('/api/admin/package', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: user?.email, target_email: pkgEmail.trim(), package_id: pkgId }) }).then((x) => x.json()); setPkgResult(r.success ? `✅ ให้แพ็กเกจแล้ว — ระดับ ${r.account.tier} · ยอดใหม่ ${r.new_balance_credits} เครดิต` : `❌ ${r.error}`); } finally { setPkgBusy(false); } }} className="px-4 py-2 rounded-lg bg-[#D4AF37] text-black font-bold disabled:opacity-40">ให้แพ็กเกจ</button>
            {pkgResult && <span className="text-text-primary">{pkgResult}</span>}
          </div>
        </div>

        {/* Billed prices (Phase 4): Fal usage export → registry rates */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-2 font-thai">
            ราคาจากบิลจริง (Fal usage export → ทะเบียนโมเดล)
          </h2>
          <p className="text-xs text-text-muted font-thai mb-4">
            ดาวน์โหลด CSV จาก fal.ai → Billing → Usage แล้วอัปโหลดที่นี่ ระบบคำนวณ $/หน่วยต่อ endpoint (รวมยอด ÷ รวมหน่วย)
            และตั้งเครดิตตามกฎ <span className="text-[#D4AF37]">เครดิต = ⌈$ × 115⌉</span> ให้ทุกโมเดลใน VFX Studio ที่มีข้อมูลบิล ≥ 2 รายการ มีผลทันทีโดยไม่ต้อง deploy
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input type="file" accept=".csv,text/csv" disabled={billBusy} onChange={(e) => { const f = e.target.files?.[0]; if (f) importBill(f); }} className="text-xs text-text-muted file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-[#D4AF37] file:text-black font-thai cursor-pointer" />
            {billBusy && <span className="text-xs text-[#D4AF37] font-thai">กำลังอ่านบิล...</span>}
          </div>
          {billResult && (
            <div className={`mt-4 rounded-xl border p-4 text-xs font-thai space-y-2 ${billResult.success ? 'border-white/10 bg-surface-2/30' : 'border-accent-danger/40 bg-accent-danger/10'}`}>
              {billResult.success ? (
                <>
                  <p className="text-text-primary">อ่านได้ {billResult.rows} รายการ (ข้าม {billResult.skipped}) · {billResult.endpoints} endpoint · รวม ${billResult.totalUsd} · อัปเดตราคาในทะเบียน {billResult.changed} รายการ</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-text-muted text-left"><th className="py-1 pr-3">endpoint</th><th className="pr-3">หน่วย</th><th className="pr-3">$/หน่วย</th><th className="pr-3">เครดิต</th><th className="pr-3">n</th><th>รวม $</th></tr></thead>
                      <tbody>{billResult.preview.map((p: any) => <tr key={p.endpoint + p.unit} className="border-t border-white/5 text-text-primary"><td className="py-1 pr-3 font-mono">{p.endpoint}</td><td className="pr-3">{p.unit}</td><td className="pr-3">{p.usdPerUnit}</td><td className="pr-3 text-[#D4AF37]">{p.credits}</td><td className="pr-3">{p.samples}</td><td>{p.usdTotal}</td></tr>)}</tbody>
                    </table>
                  </div>
                  {billResult.unmatched?.length > 0 && <p className="text-text-muted">ไม่ตรงกับทะเบียน (ยังไม่ได้ใช้ใน registry): {billResult.unmatched.map((u: any) => `${u.endpoint} $${u.usd}`).join(' · ')}</p>}
                  {billMapping.length > 0 && <p className="text-text-muted">โมเดลที่ใช้ราคาบิลตอนนี้: {billMapping.map((m: any) => `${m.id} ${m.usdPerUnit}/${m.unit}→${m.creditsPerUnit}cr`).join(' · ')}</p>}
                </>
              ) : (
                <p className="text-accent-danger">{billResult.error}</p>
              )}
            </div>
          )}
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

        {/* Video Model Configurations */}
        <div className="glow-card p-6 mb-8">
          <h2 className="text-lg font-display font-semibold text-text-primary mb-5 font-thai">
            การตั้งค่าความละเอียดและระบบเสียงของโมเดล (Video Model Settings)
          </h2>
          <div className="space-y-4">
            {/* Wan Resolution Settings */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-accent-primary" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ความละเอียดของโมเดล Wan (Cinema Mode)
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    เลือกความละเอียดของภาพ (480p ช่วยประหยัดค่าใช้จ่าย Fal.ai ลง 50%)
                  </p>
                </div>
              </div>
              <div className="flex gap-2 bg-[#1A1A1A] p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => saveWanResolution('480p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    wanResolution === '480p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  480p (ประหยัด 50%)
                </button>
                <button
                  onClick={() => saveWanResolution('720p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    wanResolution === '720p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  720p (ปกติ)
                </button>
              </div>
            </div>

            {/* Kling Resolution Settings */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-accent-warm" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ความละเอียดของโมเดล Kling 2.6 Pro (Fast Mode)
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    สลับการรันโมเดลระหว่าง Standard (720p) และ Pro (1080p)
                  </p>
                </div>
              </div>
              <div className="flex gap-2 bg-[#1A1A1A] p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => saveKlingResolution('720p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    klingResolution === '720p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  720p (Standard)
                </button>
                <button
                  onClick={() => saveKlingResolution('1080p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    klingResolution === '1080p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  1080p (Pro)
                </button>
              </div>
            </div>

            {/* Kling Ambient Audio Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                {klingAudioEnabled ? (
                  <Volume2 className="w-5 h-5 text-accent-success" />
                ) : (
                  <VolumeX className="w-5 h-5 text-text-muted" />
                )}
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ระบบเสียงแวดล้อมและเอฟเฟกต์ Kling 2.6 Pro
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    เปิดสร้างเสียงลม/เอฟเฟกต์ตาม Prompt (เมื่อเปิดจะมีราคาเป็น 2 เท่า หรือ $0.14/วินาที)
                  </p>
                </div>
              </div>
              <button
                onClick={() => saveKlingAudioEnabled(!klingAudioEnabled)}
                className="text-2xl"
              >
                {klingAudioEnabled ? (
                  <ToggleRight className="w-10 h-10 text-accent-success" />
                ) : (
                  <ToggleLeft className="w-10 h-10 text-text-muted" />
                )}
              </button>
            </div>

            {/* Grok Resolution Settings */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-accent-success" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ความละเอียดของโมเดล Grok Imagine Video
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    เลือกคุณภาพของผลลัพธ์วิดีโอ Grok 1.5
                  </p>
                </div>
              </div>
              <div className="flex gap-2 bg-[#1A1A1A] p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => saveGrokResolution('480p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    grokResolution === '480p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  480p (ประหยัด)
                </button>
                <button
                  onClick={() => saveGrokResolution('720p')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                    grokResolution === '720p'
                      ? 'bg-[#D4AF37] text-black shadow-md'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  720p (ปกติ)
                </button>
              </div>
            </div>

            {/* Seedance Resolution Settings */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2/30 border border-white/5">
              <div className="flex items-center gap-3">
                <Film className="w-5 h-5 text-accent-success" />
                <div>
                  <p className="text-sm font-medium text-text-primary font-thai">
                    ความละเอียดของโมเดล Seedance (KRUTH Nova)
                  </p>
                  <p className="text-xs text-text-muted font-thai">
                    เลือกคุณภาพของผลลัพธ์วิดีโอ Seedance 1.0 Pro
                  </p>
                </div>
              </div>
              <div className="flex gap-2 bg-[#1A1A1A] p-1 rounded-xl border border-white/5">
                {['480p', '720p', '1080p'].map((res) => (
                  <button
                    key={res}
                    onClick={() => saveSeedanceResolution(res)}
                    className={`px-4 py-2 rounded-lg text-xs font-bold transition-all font-thai ${
                      seedanceResolution === res
                        ? 'bg-[#D4AF37] text-black shadow-md'
                        : 'text-text-muted hover:text-white'
                    }`}
                  >
                    {res === '480p' ? '480p (ประหยัด)' : res === '720p' ? '720p (ปกติ)' : '1080p (คมชัด)'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Whitelist Management */}
        <div className="glow-card p-6 mb-8">
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-lg font-display font-semibold text-text-primary font-thai">
              รายชื่อผู้ใช้ที่ได้รับสิทธิ์สร้างคลิป (Whitelist & Credits Balance)
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
                    <th className="py-3 px-4 text-center font-thai">เครดิตสะสมคงเหลือ (Credits)</th>
                    <th className="py-3 px-4 text-center font-thai">สิทธิ์ (Role)</th>
                    <th className="py-3 px-4 text-right font-thai">การจัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {whitelist.map((item) => {
                    const timeLeft = getTimeLeft(item.expires_at);
                    const isExpired = timeLeft === 'หมดอายุแล้ว (Expired)';
                    const credits = (item.generation_limit || 0) / 10;
                    
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
                        <td className="py-3.5 px-4 text-center font-mono text-text-primary font-bold">
                          {credits.toFixed(1).replace('.0', '')} เครดิต
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          {item.email.toLowerCase() === 'whootthira@gmail.com' ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-accent-warm/15 text-accent-warm border border-accent-warm/20">Super Admin</span>
                          ) : item.is_admin_role ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/25">Admin</span>
                          ) : (
                            <span className="text-[10px] text-text-muted font-thai">ผู้ใช้ทั่วไป</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex justify-end gap-2">
                            {item.email.toLowerCase() !== 'whootthira@gmail.com' &&
                              item.email.toLowerCase() !== (user?.email || '').toLowerCase() && (
                              <button
                                onClick={() => handleToggleAdmin(item.email, !item.is_admin_role)}
                                className={`text-xs px-2 py-1 rounded transition-colors font-thai ${
                                  item.is_admin_role
                                    ? 'text-amber-400 hover:bg-amber-500/10'
                                    : 'text-text-muted hover:text-[#D4AF37] hover:bg-[#D4AF37]/5'
                                }`}
                              >
                                {item.is_admin_role ? 'ถอดแอดมิน' : 'ตั้งเป็นแอดมิน'}
                              </button>
                            )}
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
                  placeholder="เช่น สมศรี โปรดิวเซอร์"
                  className="w-full bg-[#2C2C2E] border border-white/10 p-3 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all"
                />
              </div>

              {/* Generation Limit -> Credits */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-text-secondary uppercase font-thai">ยอดเครดิตสะสมคงเหลือ (Credits Balance)</label>
                <input
                  type="number"
                  min="0"
                  max="999999"
                  value={limitField}
                  onChange={(e) => setLimitField(parseInt(e.target.value, 10) || 0)}
                  placeholder="100"
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

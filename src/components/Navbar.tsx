'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  Film,
  LayoutGrid,
  ShieldCheck,
  LogOut,
  Sparkles,
  Menu,
  X,
  Users,
} from 'lucide-react';
import { useState } from 'react';

export default function Navbar() {
  const { user, isAdmin, signOut } = useAuth();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { href: '/dashboard', label: 'สร้างวิดีโอ', icon: Film },
    { href: '/gallery', label: 'คลังวิดีโอ', icon: LayoutGrid },
    { href: '/characters', label: 'คลังตัวละคร', icon: Users },
    ...(isAdmin ? [{ href: '/admin', label: 'ผู้ดูแลระบบ', icon: ShieldCheck }] : []),
  ];

  return (
    <nav className="sticky top-0 z-50 border-b border-white/5 backdrop-blur-xl bg-surface-0/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center shadow-lg shadow-accent-primary/20 group-hover:shadow-accent-primary/40 transition-shadow">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-bold text-lg tracking-tight text-text-primary">
              AI Video <span className="text-accent-primary">Studio</span>
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? 'text-white bg-accent-primary/10 border border-accent-primary/20'
                      : 'text-text-secondary hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* User */}
          <div className="hidden md:flex items-center gap-3">
            <div className="flex items-center gap-2">
              {user?.user_metadata?.avatar_url && (
                <img
                  src={user.user_metadata.avatar_url}
                  alt=""
                  className="w-7 h-7 rounded-full border border-white/10"
                />
              )}
              <span className="text-sm text-text-secondary truncate max-w-[150px]">
                {user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email}
              </span>
              {isAdmin && (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-accent-warm/15 text-accent-warm border border-accent-warm/20">
                  Admin
                </span>
              )}
            </div>
            <button
              onClick={signOut}
              className="p-2 rounded-xl text-text-muted hover:text-accent-danger hover:bg-accent-danger/10 transition-all"
              title="ออกจากระบบ"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          {/* Mobile Toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 rounded-xl text-text-secondary hover:text-white"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {mobileOpen && (
          <div className="md:hidden pb-4 space-y-1 animate-slide-up">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${
                    isActive ? 'text-white bg-accent-primary/10' : 'text-text-secondary'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
            <button
              onClick={signOut}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-sm text-accent-danger"
            >
              <LogOut className="w-4 h-4" />
              ออกจากระบบ
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

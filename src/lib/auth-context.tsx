'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase, checkWhitelistUser, updateUserLogin, isSessionValid } from './supabase-db';

// 👑 กำหนดอีเมล Super Admin (เปลี่ยนเป็นอีเมล Google ของตัวเองได้เลยครับ)
const SUPER_ADMIN_EMAIL = 'whootthira@gmail.com'; 

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  whitelistData: {
    email: string;
    display_name?: string;
    expires_at?: string;
    generation_limit?: number;
    is_admin?: boolean;
  } | null;
}

const AuthContext = createContext<AuthState>({
  user: null,
  isAdmin: false,
  loading: true,
  error: null,
  signIn: async () => {},
  signOut: async () => {},
  whitelistData: null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [whitelistData, setWhitelistData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleAuthUser = useCallback(async (supabaseUser: User | null) => {
    if (supabaseUser?.email) {
      const email = supabaseUser.email;
      const isSuperAdmin = email === SUPER_ADMIN_EMAIL;
      
      // 🛡️ Super Admin ผ่านฉลุยเสมอโดยไม่ต้องเช็ก Session
      const valid = isSuperAdmin ? true : await isSessionValid(email);
      
      if (valid) {
        const userData = await checkWhitelistUser(email);
        
        // 🛡️ Super Admin เข้าได้เสมอ แม้จะไม่มีรายชื่อใน Whitelist Database
        if (userData || isSuperAdmin) {
          setUser(supabaseUser);
          setWhitelistData(userData);
          setIsAdmin(isSuperAdmin ? true : !!userData?.is_admin);
          setError(null);
          
          // Update login timestamp
          if (!isSuperAdmin || userData) {
            await updateUserLogin(email);
          }
        } else {
          await supabase.auth.signOut();
          setUser(null);
          setWhitelistData(null);
          setIsAdmin(false);
          setError('อีเมลนี้ไม่ได้รับอนุญาตให้เข้าใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
        }
      } else {
        await supabase.auth.signOut();
        setUser(null);
        setWhitelistData(null);
        setIsAdmin(false);
      }
    } else {
      setUser(null);
      setWhitelistData(null);
      setIsAdmin(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      setError('ตัวแปรสภาพแวดล้อม Supabase (NEXT_PUBLIC_SUPABASE_URL และ NEXT_PUBLIC_SUPABASE_ANON_KEY) ขาดหายไป กรุณาเพิ่มค่านี้ในหน้าตั้งค่า Environment Variables ของ Vercel และทำการ Re-deploy');
      return;
    }

    // 1. Check current session
    supabase.auth.getSession().then((res: any) => {
      const session = res?.data?.session;
      handleAuthUser(session?.user ?? null);
    });

    // 2. Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: any, session: any) => {
      handleAuthUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [handleAuthUser]);

  const signIn = useCallback(async () => {
    if (!supabase) {
      setError('ไม่สามารถเข้าสู่ระบบได้เนื่องจากขาดการเชื่อมต่อระบบ Supabase (ไม่มี Env)');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/dashboard',
        }
      });
      if (signInError) throw signInError;
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ');
      setUser(null);
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    await supabase.auth.signOut();
    setUser(null);
    setIsAdmin(false);
    setLoading(false);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, error, signIn, signOut, whitelistData }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
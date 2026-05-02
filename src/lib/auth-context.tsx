'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { auth, checkWhitelistUser, updateUserLogin, isSessionValid } from './firebase';

// 👑 กำหนดอีเมล Super Admin (เปลี่ยนเป็นอีเมล Google ของตัวเองได้เลยครับ)
const SUPER_ADMIN_EMAIL = 'whootthira@gmail.com'; 

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  isAdmin: false,
  loading: true,
  error: null,
  signIn: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser?.email) {
        const isSuperAdmin = firebaseUser.email === SUPER_ADMIN_EMAIL;
        
        // 🛡️ Super Admin ผ่านฉลุยเสมอโดยไม่ต้องเช็ก Session
        const valid = isSuperAdmin ? true : await isSessionValid(firebaseUser.email);
        
        if (valid) {
          const userData = await checkWhitelistUser(firebaseUser.email);
          
          // 🛡️ Super Admin เข้าได้เสมอ แม้จะไม่มีรายชื่อใน Whitelist Database
          if (userData || isSuperAdmin) {
            setUser(firebaseUser);
            setIsAdmin(isSuperAdmin ? true : !!userData?.is_admin);
          } else {
            await firebaseSignOut(auth);
            setUser(null);
            setIsAdmin(false);
          }
        } else {
          await firebaseSignOut(auth);
          setUser(null);
          setIsAdmin(false);
        }
      } else {
        setUser(null);
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const email = result.user.email;
      if (!email) throw new Error('ไม่พบอีเมลจาก Google Account');

      const isSuperAdmin = email === SUPER_ADMIN_EMAIL;

      // Check whitelist (ข้ามการเช็กถ้าเป็น Super Admin)
      const userData = await checkWhitelistUser(email);
      if (!userData && !isSuperAdmin) {
        await firebaseSignOut(auth);
        throw new Error('อีเมลนี้ไม่ได้รับอนุญาตให้เข้าใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
      }

      // Update login timestamp
      if (!isSuperAdmin || userData) {
         await updateUserLogin(email);
      }
      
      setUser(result.user);
      setIsAdmin(isSuperAdmin ? true : !!userData?.is_admin);
    } catch (err: any) {
      setError(err.message || 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    setUser(null);
    setIsAdmin(false);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
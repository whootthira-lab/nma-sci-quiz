import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ [KRUTH AI]: Supabase environment variables are missing!');
}

// สร้าง Instance สำหรับเรียกใช้เชื่อมต่อฐานข้อมูลและ Storage
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
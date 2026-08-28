import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPER_ADMIN_EMAIL = 'whootthira@gmail.com';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  return createClient(url, key);
}

async function isAdmin(supabase: any, email: string) {
  if (email === SUPER_ADMIN_EMAIL) return true;
  const { data } = await supabase.from('profiles').select('role').eq('email', email).maybeSingle();
  return data?.role === 'admin';
}

/** Which whitelisted users hold the admin role, for the admin page to display. */
export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get('email') || '';
    const supabase = admin();
    if (!email || !(await isAdmin(supabase, email))) {
      return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบเท่านั้น' }, { status: 403 });
    }
    const { data, error } = await supabase.from('profiles').select('email, role').eq('role', 'admin');
    if (error) throw error;
    return NextResponse.json({
      success: true,
      admin_emails: (data || []).map((r: any) => String(r.email).toLowerCase())
    });
  } catch (error: any) {
    console.error('[Admin Role GET]', error);
    return NextResponse.json({ success: false, error: error.message || 'อ่านรายชื่อแอดมินไม่สำเร็จ' }, { status: 500 });
  }
}

/**
 * Grant or revoke the admin role. Only an admin may call it, the super admin cannot be
 * demoted, and nobody can change their own role — so the last admin cannot lock everyone
 * out and a compromised account cannot quietly promote itself.
 */
export async function POST(req: NextRequest) {
  try {
    const { user_email, target_email, make_admin } = await req.json();
    if (!user_email || !target_email) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const supabase = admin();
    if (!(await isAdmin(supabase, user_email))) {
      return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสิทธิ์ได้' }, { status: 403 });
    }

    const target = String(target_email).trim().toLowerCase();
    if (target === SUPER_ADMIN_EMAIL) {
      return NextResponse.json({ success: false, error: 'บัญชี Super Admin เปลี่ยนสิทธิ์ไม่ได้' }, { status: 400 });
    }
    if (target === String(user_email).trim().toLowerCase()) {
      return NextResponse.json({ success: false, error: 'เปลี่ยนสิทธิ์ของตัวเองไม่ได้ ให้แอดมินคนอื่นทำแทน' }, { status: 400 });
    }

    // The profile row appears at first login; before that there is nothing to attach a role to
    const { data: profile } = await supabase.from('profiles').select('id').eq('email', target).maybeSingle();
    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'ผู้ใช้นี้ยังไม่เคยเข้าสู่ระบบ จึงยังตั้งเป็นแอดมินไม่ได้ (ให้ล็อกอินครั้งแรกก่อน)' },
        { status: 404 }
      );
    }

    const { error } = await supabase
      .from('profiles')
      .update({ role: make_admin ? 'admin' : 'user' })
      .eq('id', profile.id);
    if (error) throw error;

    console.log(`[Admin Role] ${target} → ${make_admin ? 'admin' : 'user'} (by ${user_email})`);
    return NextResponse.json({ success: true, role: make_admin ? 'admin' : 'user' });
  } catch (error: any) {
    console.error('[Admin Role POST]', error);
    return NextResponse.json({ success: false, error: error.message || 'เปลี่ยนสิทธิ์ไม่สำเร็จ' }, { status: 500 });
  }
}

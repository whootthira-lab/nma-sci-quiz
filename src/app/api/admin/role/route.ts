import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/auth-server';
import { createClient } from '@supabase/supabase-js';
import { audit } from '@/lib/audit';

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
    const body = await req.json();
    const { user_email, target_email, make_admin } = body;
    { const g = await guard(req, user_email); if (g instanceof NextResponse) return g; }
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

    // Roles (Content Policy §6): user · reviewer (moderation queue only) · admin. The older
    // `make_admin` boolean still works; `role` names any of the three.
    const requested = typeof body.role === 'string' ? body.role : (make_admin ? 'admin' : 'user');
    const role = ['admin', 'reviewer', 'user'].includes(requested) ? requested : 'user';
    const { error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', profile.id);
    if (error) throw error;

    await audit({ kind: 'role_changed', actor: String(user_email).toLowerCase(), target, detail: { role } });
    console.log(`[Admin Role] ${target} → ${role} (by ${user_email})`);
    return NextResponse.json({ success: true, role });
  } catch (error: any) {
    console.error('[Admin Role POST]', error);
    return NextResponse.json({ success: false, error: error.message || 'เปลี่ยนสิทธิ์ไม่สำเร็จ' }, { status: 500 });
  }
}

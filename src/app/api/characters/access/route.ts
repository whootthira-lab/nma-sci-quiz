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

/**
 * Characters carry someone's face, so who may use one is decided here rather than in the
 * browser: the row is only reachable with the service key, and the caller gets back their
 * own, the ones shared with their address, and — for an admin — everything.
 */
export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get('email') || '';
    const trainedOnly = req.nextUrl.searchParams.get('trained_only') === 'true';
    if (!email) {
      return NextResponse.json({ success: false, error: 'ต้องระบุอีเมลผู้ใช้' }, { status: 400 });
    }

    const supabase = admin();
    const elevated = await isAdmin(supabase, email);

    let query = supabase.from('characters').select('*').order('created_at', { ascending: false });
    if (trainedOnly) query = query.eq('lora_status', 'succeeded');

    const { data, error } = await query;
    if (error) throw error;

    const { data: profile } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle();
    const myId = profile?.id;
    const lower = email.toLowerCase();

    const visible = (data || []).filter((c: any) => {
      if (elevated) return true;
      if (c.is_disabled) return false; // withdrawn from use until an admin restores it
      if (myId && c.user_id === myId) return true;
      const shared: string[] = Array.isArray(c.shared_with) ? c.shared_with : [];
      return shared.some((e) => String(e).toLowerCase() === lower);
    });

    // Mark what the caller may change, so the UI never offers an action that would be refused
    const characters = visible.map((c: any) => ({
      ...c,
      is_owner: !!myId && c.user_id === myId,
      shared_with: Array.isArray(c.shared_with) ? c.shared_with : []
    }));

    return NextResponse.json({ success: true, characters, is_admin: elevated });
  } catch (error: any) {
    console.error('[Characters Access]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'อ่านรายชื่อตัวละครไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

/** Replace the list of addresses a character is shared with. Owner or admin only. */
export async function POST(req: NextRequest) {
  try {
    const { character_id, user_email, shared_with } = await req.json();
    if (!character_id || !user_email) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const supabase = admin();
    const { data: character } = await supabase
      .from('characters')
      .select('user_id')
      .eq('id', character_id)
      .maybeSingle();
    if (!character) {
      return NextResponse.json({ success: false, error: 'ไม่พบตัวละครนี้' }, { status: 404 });
    }

    const { data: profile } = await supabase.from('profiles').select('id').eq('email', user_email).maybeSingle();
    const elevated = await isAdmin(supabase, user_email);
    if (!elevated && (!profile || profile.id !== character.user_id)) {
      return NextResponse.json(
        { success: false, error: 'เฉพาะเจ้าของตัวละครเท่านั้นที่แก้ไขการแชร์ได้' },
        { status: 403 }
      );
    }

    const cleaned = Array.from(
      new Set(
        (Array.isArray(shared_with) ? shared_with : [])
          .map((e: any) => String(e).trim().toLowerCase())
          .filter((e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      )
    );

    const { error } = await supabase
      .from('characters')
      .update({ shared_with: cleaned })
      .eq('id', character_id);
    if (error) throw error;

    return NextResponse.json({ success: true, shared_with: cleaned });
  } catch (error: any) {
    console.error('[Characters Share]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'บันทึกการแชร์ไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

/**
 * Admin moderation: take a character out of use, or delete it outright. Hosting someone
 * else's likeness means there has to be a way to act on a copyright or consent complaint,
 * and who did it is recorded so the action can be answered for.
 */
export async function PATCH(req: NextRequest) {
  try {
    const { character_id, user_email, disabled, reason } = await req.json();
    if (!character_id || !user_email) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const supabase = admin();
    if (!(await isAdmin(supabase, user_email))) {
      return NextResponse.json(
        { success: false, error: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ระงับตัวละครของผู้อื่นได้' },
        { status: 403 }
      );
    }

    const { error } = await supabase
      .from('characters')
      .update({
        is_disabled: !!disabled,
        disabled_reason: disabled ? (reason || 'ระงับโดยผู้ดูแลระบบ') : null,
        disabled_by: disabled ? user_email : null,
        disabled_at: disabled ? new Date().toISOString() : null
      })
      .eq('id', character_id);
    if (error) throw error;

    return NextResponse.json({ success: true, disabled: !!disabled });
  } catch (error: any) {
    console.error('[Characters Moderate]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'ระงับตัวละครไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { character_id, user_email } = await req.json();
    if (!character_id || !user_email) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน' }, { status: 400 });
    }

    const supabase = admin();
    const { data: character } = await supabase
      .from('characters')
      .select('user_id')
      .eq('id', character_id)
      .maybeSingle();
    if (!character) {
      return NextResponse.json({ success: false, error: 'ไม่พบตัวละครนี้' }, { status: 404 });
    }

    const { data: profile } = await supabase.from('profiles').select('id').eq('email', user_email).maybeSingle();
    const elevated = await isAdmin(supabase, user_email);
    if (!elevated && (!profile || profile.id !== character.user_id)) {
      return NextResponse.json(
        { success: false, error: 'เฉพาะเจ้าของหรือผู้ดูแลระบบเท่านั้นที่ลบตัวละครนี้ได้' },
        { status: 403 }
      );
    }

    const { error } = await supabase.from('characters').delete().eq('id', character_id);
    if (error) throw error;

    console.log(`[Characters] ${character_id} deleted by ${user_email}${elevated ? ' (admin)' : ''}`);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Characters Delete]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'ลบตัวละครไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

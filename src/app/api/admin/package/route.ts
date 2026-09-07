import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { PACKAGES, grantPackage, loadAccount, saveAccount } from '@/lib/credits/packages';

export const dynamic = 'force-dynamic';

async function isAdmin(email: string) {
  if (email === 'whootthira@gmail.com') return true;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  const { data } = await createClient(url, key).from('profiles').select('role').eq('email', email).maybeSingle();
  return data?.role === 'admin';
}

/** GET ?email=<admin>[&for=<user>] → packages, and that user's account tier/history */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').toLowerCase();
  const target = (req.nextUrl.searchParams.get('for') || '').toLowerCase();
  if (!(await isAdmin(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบ' }, { status: 403 });
  const account = target ? await loadAccount(target) : null;
  return NextResponse.json({ success: true, packages: PACKAGES, account });
}

/** POST { user_email(admin), target_email, package_id, note? } → grant; { action:'set_tier', target_email, tier } → tier only */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').toLowerCase();
    if (!(await isAdmin(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบ' }, { status: 403 });
    const target = String(body.target_email || '').toLowerCase();
    if (!target) return NextResponse.json({ success: false, error: 'ระบุอีเมลผู้ใช้' }, { status: 400 });
    if (body.action === 'set_tier') {
      const acc = await loadAccount(target);
      acc.tier = ['economy', 'pro', 'ultra'].includes(body.tier) ? body.tier : acc.tier;
      acc.history.unshift({ at: new Date().toISOString(), package_id: `tier:${acc.tier}`, credits: 0, price_thb: 0, by: email, note: body.note });
      await saveAccount(acc);
      return NextResponse.json({ success: true, account: acc });
    }
    const r = await grantPackage(target, body.package_id, email, body.note);
    return NextResponse.json({ success: true, account: r.account, new_balance_credits: r.newBalance / 10 });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'ให้แพ็กเกจไม่สำเร็จ' }, { status: 400 });
  }
}

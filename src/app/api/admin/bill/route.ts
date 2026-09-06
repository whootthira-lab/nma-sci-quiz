import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseUsageCsv, buildRateTable, saveRateTable, loadRateTable, primeRates, creditsFromUsd } from '@/lib/providers/rates';
import { MODELS } from '@/lib/providers/registry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function isAdmin(email: string) {
  if (email === 'whootthira@gmail.com') return true;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  const { data } = await createClient(url, key).from('profiles').select('role').eq('email', email).maybeSingle();
  return data?.role === 'admin';
}

/** GET ?email= → the billed rate table and how it maps onto the registry. */
export async function GET(req: NextRequest) {
  const email = (req.nextUrl.searchParams.get('email') || '').toLowerCase();
  if (!(await isAdmin(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบ' }, { status: 403 });
  const table = await loadRateTable(true);
  await primeRates();
  const mapping = MODELS.map((m) => {
    const row = table?.rows.find((r) => r.endpoint === m.endpoint && r.unit === m.unit);
    return { id: m.id, endpoint: m.endpoint, unit: m.unit, tier: m.tier, verified: m.verified, usdPerUnit: m.usdPerUnit, creditsPerUnit: m.creditsPerUnit, priceSource: m.priceSource, billed: row ? { usdPerUnit: +row.usdPerUnit.toFixed(5), samples: row.samples, usdTotal: +row.usdTotal.toFixed(3) } : null };
  });
  return NextResponse.json({ success: true, table, mapping });
}

/** POST { user_email, csv, source } → parse a Fal usage export, store the rate table, apply it. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').toLowerCase();
    if (!(await isAdmin(email))) return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบ' }, { status: 403 });
    const csv = String(body.csv || '');
    if (csv.length < 20) return NextResponse.json({ success: false, error: 'ไม่พบข้อมูล CSV' }, { status: 400 });
    const parsed = parseUsageCsv(csv);
    if (!parsed.rows.length) return NextResponse.json({ success: false, error: `อ่านคอลัมน์ไม่ได้ (พบ: ${JSON.stringify(parsed.columns)})` }, { status: 400 });
    const table = buildRateTable(parsed.rows, String(body.source || 'upload'));
    await saveRateTable(table);
    const changed = await primeRates();
    const totalUsd = table.rows.reduce((s, r) => s + r.usdTotal, 0);
    const unmatched = table.rows.filter((r) => !MODELS.some((m) => m.endpoint === r.endpoint)).map((r) => ({ endpoint: r.endpoint, usd: +r.usdTotal.toFixed(2) }));
    return NextResponse.json({
      success: true,
      columns: parsed.columns,
      rows: parsed.rows.length,
      skipped: parsed.skipped,
      endpoints: table.rows.length,
      totalUsd: +totalUsd.toFixed(2),
      changed,
      unmatched: unmatched.slice(0, 20),
      preview: table.rows.slice(0, 15).map((r) => ({ endpoint: r.endpoint, unit: r.unit, usdPerUnit: +r.usdPerUnit.toFixed(4), credits: creditsFromUsd(r.usdPerUnit), samples: r.samples, usdTotal: +r.usdTotal.toFixed(2) }))
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'นำเข้าบิลไม่สำเร็จ' }, { status: 500 });
  }
}

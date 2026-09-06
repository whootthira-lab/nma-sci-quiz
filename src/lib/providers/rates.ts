import { createClient } from '@supabase/supabase-js';
import { MODELS } from './registry';

/**
 * Rates from the bill (Phase 4). Fal's usage export is the only price that counts (iron
 * rule 2); an admin uploads it, this module turns it into $/unit per endpoint, stores the
 * table, and the registry's in-memory entries are overwritten with it at the start of every
 * request that prices something. Displayed credits follow one rule everywhere:
 *   credits = ceil(usd × 115)   (1 credit ≈ $0.01 with a 15% margin, minimum 1)
 * which reproduces the hand-set values (O3 std 0.084 → 10, veed 0.0122 → 2, lip-sync 0.014 → 2).
 */

export interface RateRow {
  endpoint: string;       // exact Fal path as billed
  usdPerUnit: number;
  unit: 'second' | 'image' | 'megapixel' | 'clip';
  samples: number;        // billed rows behind the number
  usdTotal: number;
  units: number;
  updated_at: string;
}
export interface RateTable {
  version: 1;
  imported_at: string;
  source: string;         // file name
  rows: RateRow[];
}

const BUCKET = 'kruth-ai-assets';
const PATH = 'vfx_billing/rates.json';

export function creditsFromUsd(usd: number): number {
  return Math.max(1, Math.ceil(usd * 115));
}

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

let cache: { table: RateTable | null; at: number } = { table: null, at: 0 };

export async function loadRateTable(force = false): Promise<RateTable | null> {
  if (!force && cache.table && Date.now() - cache.at < 5 * 60 * 1000) return cache.table;
  try {
    const { data, error } = await client().storage.from(BUCKET).download(PATH);
    if (error || !data) { cache = { table: null, at: Date.now() }; return null; }
    const table = JSON.parse(await data.text()) as RateTable;
    cache = { table, at: Date.now() };
    return table;
  } catch {
    return cache.table;
  }
}

export async function saveRateTable(table: RateTable): Promise<void> {
  const { error } = await client().storage.from(BUCKET).upload(PATH, Buffer.from(JSON.stringify(table, null, 1)), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`บันทึกตารางราคาไม่สำเร็จ: ${error.message}`);
  cache = { table, at: Date.now() };
}

/** Overwrite registry prices with billed ones. Call before pricing anything. Returns how many entries changed. */
export async function primeRates(): Promise<number> {
  const table = await loadRateTable();
  if (!table) return 0;
  let changed = 0;
  for (const m of MODELS) {
    const row = table.rows.find((r) => r.endpoint === m.endpoint && r.unit === m.unit && r.samples >= 2);
    if (!row) continue;
    const credits = creditsFromUsd(row.usdPerUnit);
    if (Math.abs(m.usdPerUnit - row.usdPerUnit) > 1e-6 || m.creditsPerUnit !== credits) {
      m.usdPerUnit = +row.usdPerUnit.toFixed(5);
      m.creditsPerUnit = credits;
      m.priceSource = 'bill';
      changed++;
    }
  }
  return changed;
}

/**
 * Parse a Fal usage export. Column names differ between exports, so the reader looks for
 * the endpoint/app column, a cost column, and a quantity column by keyword, and reports
 * what it recognised so an admin can see why a row was skipped.
 */
export function parseUsageCsv(text: string): { rows: { endpoint: string; usd: number; qty: number; unit: RateRow['unit'] }[]; columns: Record<string, string | null>; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], columns: {}, skipped: 0 };
  const split = (l: string) => {
    const out: string[] = []; let cur = ''; let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const find = (...keys: string[]) => { const i = header.findIndex((h) => keys.some((k) => h.includes(k))); return i >= 0 ? i : null; };
  const iEndpoint = find('endpoint', 'app_id', 'application', 'app', 'model');
  const iCost = find('cost', 'amount', 'price', 'usd', 'total');
  const iQty = find('quantity', 'units', 'duration', 'seconds', 'megapixel', 'count');
  const iUnit = find('unit');
  const columns = { endpoint: iEndpoint != null ? header[iEndpoint] : null, cost: iCost != null ? header[iCost] : null, quantity: iQty != null ? header[iQty] : null, unit: iUnit != null ? header[iUnit] : null };
  if (iEndpoint == null || iCost == null) return { rows: [], columns, skipped: lines.length - 1 };
  const rows: { endpoint: string; usd: number; qty: number; unit: RateRow['unit'] }[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = split(line);
    const endpoint = (c[iEndpoint] || '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+|\/+$/g, '');
    const usd = parseFloat((c[iCost] || '').replace(/[^0-9.\-]/g, ''));
    const qty = iQty != null ? parseFloat((c[iQty] || '').replace(/[^0-9.]/g, '')) : NaN;
    if (!endpoint || !isFinite(usd)) { skipped++; continue; }
    // Fal's units as seen in the August 2026 export: images · megapixels · "processed
    // megapixels" · seconds · minutes (sync-lipsync) · units (grok edits, = images) ·
    // credits/generations (= clips) · "compute seconds" (GPU time, not comparable → skipped)
    const unitText = (iUnit != null ? c[iUnit] : c[iQty ?? 0] || '').toLowerCase();
    let q = isFinite(qty) && qty > 0 ? qty : 1;
    let unit: RateRow['unit'];
    if (/compute|token/.test(unitText)) { skipped++; continue; }
    else if (/megapixel|mp\b/.test(unitText)) unit = 'megapixel';
    else if (/minute/.test(unitText)) { unit = 'second'; q *= 60; }
    else if (/second|sec|duration|video/.test(unitText) || (iQty != null && header[iQty].includes('second'))) unit = 'second';
    else if (/image|img|unit/.test(unitText)) unit = 'image';
    else unit = 'clip';
    rows.push({ endpoint, usd, qty: q, unit });
  }
  return { rows, columns, skipped };
}

/** Aggregate parsed rows into a rate table (sum cost ÷ sum units per endpoint+unit). */
export function buildRateTable(parsed: ReturnType<typeof parseUsageCsv>['rows'], source: string): RateTable {
  const agg = new Map<string, RateRow>();
  const now = new Date().toISOString();
  for (const r of parsed) {
    const k = `${r.endpoint}|${r.unit}`;
    const row = agg.get(k) || { endpoint: r.endpoint, unit: r.unit, usdPerUnit: 0, samples: 0, usdTotal: 0, units: 0, updated_at: now };
    row.samples += 1; row.usdTotal += r.usd; row.units += r.qty;
    agg.set(k, row);
  }
  const rows = Array.from(agg.values()).map((r) => ({ ...r, usdPerUnit: r.units > 0 ? r.usdTotal / r.units : 0 })).filter((r) => r.usdPerUnit > 0);
  return { version: 1, imported_at: now, source, rows: rows.sort((a, b) => b.usdTotal - a.usdTotal) };
}

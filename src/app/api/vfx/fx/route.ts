import { NextRequest, NextResponse } from 'next/server';
import { loadFxLibrary, saveFxLibrary, fxClipPath, fxClipUrl, FxElement } from '@/lib/vfx/fx';
import { serviceClient } from '@/lib/vfx/store';
import { probeVideo, fetchToFile } from '@/lib/vfx/composite';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/** GET → the stock FX library. */
export async function GET() {
  try {
    return NextResponse.json({ success: true, elements: await loadFxLibrary() });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'อ่านคลัง FX ไม่สำเร็จ' }, { status: 500 });
  }
}

/**
 * POST (admin) → register an uploaded on-black clip as a library element.
 * Body: { user_email, id, label, url, placement?, opacity?, tags? }. The clip must already be
 * in storage (signed upload); it is copied under vfx_fx/<id>.mp4 and measured.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.user_email || '').trim().toLowerCase();
    const supabase = serviceClient();
    const { data: profile } = await supabase.from('profiles').select('role').eq('email', email).maybeSingle();
    const isAdmin = email === 'whootthira@gmail.com' || profile?.role === 'admin';
    if (!isAdmin) return NextResponse.json({ success: false, error: 'เฉพาะผู้ดูแลระบบ' }, { status: 403 });

    const id = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = String(body.label || '').trim();
    const url = String(body.url || '');
    if (!id || !label || !url) return NextResponse.json({ success: false, error: 'ต้องมี id, label และ url ของคลิป' }, { status: 400 });

    const tmp = path.join(os.tmpdir(), `fx_${Date.now()}.mp4`);
    try {
      await fetchToFile(url, tmp);
      const info = await probeVideo(tmp);
      if (!info.seconds) throw new Error('อ่านคลิปไม่ได้');
      const { error } = await supabase.storage.from('kruth-ai-assets').upload(fxClipPath(id), fs.readFileSync(tmp), { contentType: 'video/mp4', upsert: true });
      if (error) throw new Error(error.message);
      const el: FxElement = {
        id, label, url: fxClipUrl(id, supabase), seconds: +info.seconds.toFixed(2),
        default_placement: body.placement === 'behind' ? 'behind' : 'front',
        default_opacity: Math.min(1, Math.max(0.05, Number(body.opacity) || 0.7)),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        source: 'uploaded', created_at: new Date().toISOString()
      };
      const lib = (await loadFxLibrary(supabase)).filter((e) => e.id !== id);
      lib.push(el);
      await saveFxLibrary(lib, supabase);
      return NextResponse.json({ success: true, element: el, elements: lib });
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'เพิ่ม FX ไม่สำเร็จ' }, { status: 500 });
  }
}

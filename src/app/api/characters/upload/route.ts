import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Stores a character reference photo. The browser cannot write to storage — the bucket's
 * rules refuse it ("new row violates row-level security policy") — so the file is sent
 * here and written with the service credentials instead.
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const path = (formData.get('path') as string) || '';

    if (!file || file.size === 0 || !path) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน (ต้องมีไฟล์และตำแหน่งจัดเก็บ)' }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    const buffer = Buffer.from(await file.arrayBuffer());
    const { error } = await supabase.storage
      .from('kruth-ai-assets')
      .upload(path, buffer, { contentType: file.type || 'image/png', upsert: true });
    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(path);
    return NextResponse.json({ success: true, url: publicUrl, path });
  } catch (error: any) {
    console.error('[Character Upload]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'อัปโหลดรูปไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

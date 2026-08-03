import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function serviceClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  return createClient(supabaseUrl, supabaseKey);
}

/**
 * Hands the browser a one-shot permit to write a single named file, so the photo travels
 * straight to storage instead of through here. Anything routed through this server is
 * capped at ~4.5 MB by the platform and a phone photo clears that easily — the request
 * was being rejected before any of our code ran, which is why the failure arrived as
 * "Request Entity Too Large" rather than a message anyone could act on.
 */
export async function PUT(req: NextRequest) {
  try {
    const { path } = await req.json();
    if (!path) {
      return NextResponse.json({ success: false, error: 'ต้องระบุตำแหน่งจัดเก็บ' }, { status: 400 });
    }

    const supabase = serviceClient();
    const { data, error } = await supabase.storage
      .from('kruth-ai-assets')
      .createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from('kruth-ai-assets').getPublicUrl(path);
    return NextResponse.json({ success: true, token: data.token, path: data.path, url: publicUrl });
  } catch (error: any) {
    console.error('[Character Upload Sign]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'ขอสิทธิ์อัปโหลดไม่สำเร็จ' },
      { status: 500 }
    );
  }
}

/**
 * Relays a file to storage. Kept as the fallback for when a permit cannot be issued;
 * the browser cannot write to the bucket on its own, since its rules refuse the write
 * ("new row violates row-level security policy").
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const path = (formData.get('path') as string) || '';

    if (!file || file.size === 0 || !path) {
      return NextResponse.json({ success: false, error: 'ข้อมูลไม่ครบถ้วน (ต้องมีไฟล์และตำแหน่งจัดเก็บ)' }, { status: 400 });
    }

    const supabase = serviceClient();
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

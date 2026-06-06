import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 hours ago

    // Get expired generations
    const { data: expired, error: fetchError } = await supabase
      .from('generations')
      .select('id, metadata, source_image_url, video_url, audio_prompt')
      .lt('created_at', cutoffTime);

    if (fetchError) throw fetchError;

    let deletedCount = 0;

    if (expired && expired.length > 0) {
      for (const gen of expired) {
        const isFirebase = gen.metadata?.storage_provider === 'firebase' || gen.video_url?.includes('firebasestorage');

        // Collect paths to delete from Supabase
        const supabasePaths: string[] = [];
        if (gen.metadata?.image_path) supabasePaths.push(gen.metadata.image_path);
        if (gen.metadata?.audio_path) supabasePaths.push(gen.metadata.audio_path);
        if (gen.metadata?.driving_path) supabasePaths.push(gen.metadata.driving_path);
        if (!isFirebase && gen.metadata?.storage_path) supabasePaths.push(gen.metadata.storage_path);

        // Delete from Supabase Storage
        if (supabasePaths.length > 0) {
          try {
            await supabase.storage.from('kruth-ai-assets').remove(supabasePaths);
          } catch (e) {
            console.warn('Failed to delete Supabase storage files for generation:', gen.id, e);
          }
        }

        // Delete from Firebase Storage (using server-side admin SDK)
        if (isFirebase && gen.metadata?.storage_path) {
          try {
            const { adminStorage } = await import('../../../lib/admin');
            const bucket = adminStorage.bucket();
            await bucket.file(gen.metadata.storage_path).delete();
          } catch (e) {
            console.warn('Failed to delete Firebase Storage file for generation:', gen.id, e);
          }
        }

        // Delete DB row
        const { error: deleteError } = await supabase
          .from('generations')
          .delete()
          .eq('id', gen.id);

        if (deleteError) {
          console.error('Failed to delete generation row:', gen.id, deleteError);
        } else {
          deletedCount++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      deleted_count: deletedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Cleanup error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
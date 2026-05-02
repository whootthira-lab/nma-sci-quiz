import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { adminDb, adminStorage } = await import('../../../lib/admin');

    const firestore = adminDb;
    const storage = adminStorage.bucket();
    const admin = await import('firebase-admin');
    const now = admin.firestore.Timestamp.now();

    const expiredQuery = await firestore
      .collection('generations')
      .where('expires_at', '<=', now)
      .get();

    let deletedCount = 0;
    const batch = firestore.batch();

    for (const doc of expiredQuery.docs) {
      const data = doc.data();

      if (data.storage_path) {
        try {
          await storage.file(data.storage_path).delete();
        } catch (e) {}
      }

      if (data.image_url && data.image_url.includes('firebase')) {
        try {
          const imagePath = decodeURIComponent(
            data.image_url.split('/o/')[1]?.split('?')[0] || ''
          );
          if (imagePath) await storage.file(imagePath).delete();
        } catch (e) {}
      }

      batch.delete(doc.ref);
      deletedCount++;
    }

    if (deletedCount > 0) {
      await batch.commit();
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
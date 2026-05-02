import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    // Verify admin authorization header or cron secret
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Initialize Firebase Admin
    const admin = await import('firebase-admin');
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'
      );
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      });
    }

    const firestore = admin.firestore();
    const storage = admin.storage().bucket();
    const now = admin.firestore.Timestamp.now();

    // Query expired generations
    const expiredQuery = await firestore
      .collection('generations')
      .where('expires_at', '<=', now)
      .get();

    let deletedCount = 0;
    const batch = firestore.batch();

    for (const doc of expiredQuery.docs) {
      const data = doc.data();

      // Delete associated storage files
      if (data.storage_path) {
        try {
          await storage.file(data.storage_path).delete();
        } catch (e) {
          // File may already be deleted
        }
      }

      // Delete image if stored
      if (data.image_url && data.image_url.includes('firebase')) {
        try {
          const imagePath = decodeURIComponent(
            data.image_url.split('/o/')[1]?.split('?')[0] || ''
          );
          if (imagePath) await storage.file(imagePath).delete();
        } catch (e) {
          // Ignore
        }
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

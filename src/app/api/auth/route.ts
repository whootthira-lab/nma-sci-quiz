import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json(
        { valid: false, error: 'No email provided' },
        { status: 400 }
      );
    }

    const admin = await import('firebase-admin');
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'
      );
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    const firestore = admin.firestore();
    const userDoc = await firestore.collection('users').doc(email).get();

    if (!userDoc.exists) {
      return NextResponse.json({ valid: false, error: 'User not whitelisted' });
    }

    const userData = userDoc.data();
    const now = new Date();
    const expiresAt = userData?.expires_at?.toDate();

    if (expiresAt && expiresAt < now) {
      return NextResponse.json({ valid: false, error: 'Session expired' });
    }

    return NextResponse.json({
      valid: true,
      is_admin: !!userData?.is_admin,
    });
  } catch (error: any) {
    console.error('Auth check error:', error);
    return NextResponse.json(
      { valid: false, error: error.message },
      { status: 500 }
    );
  }
}

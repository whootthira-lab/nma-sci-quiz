import admin from 'firebase-admin';

function getPrivateKey(): string {
  const key = process.env.FIREBASE_PRIVATE_KEY || '';
  // รองรับทุกกรณี: มี \n จริง, มี \\n, หรือมี quotes ครอบ
  return key
    .replace(/^"|"$/g, '')  // ลบ quotes ครอบนอกสุด
    .replace(/\\n/g, '\n'); // แปลง \n เป็น newline จริง
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  try {
    const privateKey = getPrivateKey();
    console.log('[Firebase] privateKey starts with:', privateKey.substring(0, 30));

    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
  } catch (error) {
    console.error('Firebase init error:', error);
    return admin.initializeApp({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
  }
}

const app = initFirebaseAdmin();
export const adminDb = admin.firestore();
export const adminStorage = admin.storage();
export const adminAuth = admin.auth();
export default admin;
import admin from 'firebase-admin';

function getPrivateKey(): string {
  const key = process.env.FIREBASE_PRIVATE_KEY || '';
  return key
    .replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n');
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  try {
    const serviceAccountKey = process.env.NEXT_PUBLIC_FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountKey) {
      console.log('[Firebase] Initializing with service account key...');
      const cleanKey = serviceAccountKey.startsWith("'") && serviceAccountKey.endsWith("'")
        ? serviceAccountKey.slice(1, -1)
        : serviceAccountKey;
      const serviceAccount = JSON.parse(cleanKey);
      return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      });
    }

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
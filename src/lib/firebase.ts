import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, query, where, orderBy, getDocs, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ─── User Helpers ───────────────────────────────────

export async function checkWhitelistUser(email: string) {
  const userRef = doc(db, 'users', email);
  const snap = await getDoc(userRef);
  if (!snap.exists()) return null;
  return snap.data();
}

export async function updateUserLogin(email: string) {
  const userRef = doc(db, 'users', email);
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12h session
  await setDoc(userRef, {
    last_login: Timestamp.fromDate(now),
    expires_at: Timestamp.fromDate(expires),
  }, { merge: true });
}

export async function isSessionValid(email: string): Promise<boolean> {
  const userRef = doc(db, 'users', email);
  const snap = await getDoc(userRef);
  if (!snap.exists()) return false;
  const data = snap.data();
  if (!data.expires_at) return false;
  return data.expires_at.toDate() > new Date();
}

// ─── Generation Helpers ─────────────────────────────

export async function createGeneration(data: Record<string, any>) {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h retention
  const genRef = await addDoc(collection(db, 'generations'), {
    ...data,
    created_at: serverTimestamp(),
    expires_at: Timestamp.fromDate(expires),
  });
  return genRef.id;
}

export async function getUserGenerations(email: string) {
  const q = query(
    collection(db, 'generations'),
    where('user_email', '==', email),
    orderBy('created_at', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteGeneration(docId: string, storagePath: string) {
  // Delete storage file
  if (storagePath) {
    try {
      const fileRef = ref(storage, storagePath);
      await deleteObject(fileRef);
    } catch (e) {
      console.warn('Storage file not found:', storagePath);
    }
  }
  // Delete Firestore doc
  await deleteDoc(doc(db, 'generations', docId));
}

// ─── Storage Helpers ────────────────────────────────

export async function uploadToStorage(
  file: File | Blob,
  path: string
): Promise<string> {
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

export async function uploadBufferToStorage(
  buffer: ArrayBuffer,
  path: string,
  contentType: string
): Promise<string> {
  const storageRef = ref(storage, path);
  const blob = new Blob([buffer], { type: contentType });
  await uploadBytes(storageRef, blob);
  return getDownloadURL(storageRef);
}

// ─── Cleanup (24h expired docs) ─────────────────────

export async function cleanupExpiredGenerations() {
  const now = Timestamp.fromDate(new Date());
  const q = query(
    collection(db, 'generations'),
    where('expires_at', '<=', now)
  );
  const snap = await getDocs(q);
  const promises = snap.docs.map(async (d) => {
    const data = d.data();
    if (data.storage_path) {
      try {
        const fileRef = ref(storage, data.storage_path);
        await deleteObject(fileRef);
      } catch (e) { /* ignore */ }
    }
    await deleteDoc(d.ref);
  });
  await Promise.all(promises);
  return snap.size;
}

export { Timestamp };

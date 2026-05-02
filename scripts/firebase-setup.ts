/**
 * Firebase Setup Script
 * Run this once to initialize the Firestore database with initial data.
 *
 * Usage:
 *   1. Set environment variables (see .env.example)
 *   2. Run: npx tsx scripts/firebase-setup.ts
 */

import admin from 'firebase-admin';

// Load service account from environment
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();

async function setup() {
  console.log('🔧 Setting up Firebase...\n');

  // ─── 1. Create Whitelist Users ────────────────────
  console.log('📝 Creating whitelist users...');

  const users = [
    {
      email: 'admin@example.com', // Replace with your admin email
      is_admin: true,
      display_name: 'Admin',
    },
    {
      email: 'teacher1@example.com', // Replace with teacher emails
      is_admin: false,
      display_name: 'Teacher 1',
    },
  ];

  for (const user of users) {
    await db.collection('users').doc(user.email).set({
      email: user.email,
      is_admin: user.is_admin,
      display_name: user.display_name,
      last_login: admin.firestore.Timestamp.now(),
      expires_at: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 12 * 60 * 60 * 1000)
      ),
    });
    console.log(`  ✅ ${user.email} (${user.is_admin ? 'Admin' : 'User'})`);
  }

  // ─── 2. Create Admin Config ───────────────────────
  console.log('\n⚙️  Creating admin config...');
  await db.collection('admin_config').doc('settings').set({
    mode1_enabled: true,
    mode2_enabled: true,
    max_daily_generations: 50,
  });
  console.log('  ✅ Admin config initialized');

  // ─── 3. Create Firestore Indexes ──────────────────
  console.log('\n📊 Required Firestore Indexes:');
  console.log('  Collection: generations');
  console.log('  Index 1: user_email ASC, created_at DESC');
  console.log('  Index 2: expires_at ASC');
  console.log('  → Create these in Firebase Console > Firestore > Indexes');

  console.log('\n✨ Setup complete!');
  process.exit(0);
}

setup().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

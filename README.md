# AI Video Studio — แพลตฟอร์มสร้างวิดีโอ AI สำหรับครู

สร้างวิดีโอการสอนคุณภาพสูงด้วย AI เทคโนโลยี Text-to-Video และ Face Motion

## ✨ Features

### Mode 1: Text & Image → Video (Wan 2.5 Cinema)
- อัพโหลดรูปภาพอ้างอิง → สร้างวิดีโออัตโนมัติ
- บทพากย์ภาษาไทย (สูงสุด 300 ตัวอักษร)
- เสียงพากย์ Thai TTS 6 เสียง (Azure Neural Voice)
- ระยะเวลาอัตโนมัติ (~17 ตัวอักษร/วินาที)
- อัตราส่วน: 1:1, 16:9, 9:16

### Mode 2: Face Motion (Admin Only)
- LivePortrait: ถ่ายทอดการเคลื่อนไหวใบหน้าจากวิดีโอต้นแบบ
- Hallo: สร้างการเคลื่อนไหวจากเสียง (Audio-driven)

### ระบบ
- Whitelist Authentication (Google Sign-In)
- เซสชันหมดอายุ 12 ชม.
- ข้อมูลลบอัตโนมัติ 24 ชม.
- Admin Dashboard พร้อม Master Switches
- Firebase Security Rules

---

## 🛠 Tech Stack

| Layer     | Technology                         |
|-----------|------------------------------------|
| Frontend  | Next.js 14 (App Router), Tailwind  |
| Auth      | Firebase Auth (Google)             |
| Database  | Cloud Firestore                    |
| Storage   | Firebase Cloud Storage             |
| Video AI  | Fal.ai (Wan 2.5, LivePortrait)     |
| Voice     | Azure Speech SDK (Thai TTS)        |
| Icons     | Lucide React                       |

---

## 📁 Project Structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout + AuthProvider
│   ├── page.tsx            # Root redirect
│   ├── login/page.tsx      # Login page
│   ├── dashboard/page.tsx  # Video creation (Mode 1 & 2)
│   ├── gallery/page.tsx    # Personal video gallery
│   ├── admin/page.tsx      # Admin dashboard
│   └── api/
│       ├── generate-video/ # Mode 1 API (Wan 2.5 + TTS)
│       ├── face-motion/    # Mode 2 API (LivePortrait/Hallo)
│       ├── generate-tts/   # TTS preview endpoint
│       ├── cleanup/        # Data cleanup (24h expiry)
│       └── auth/           # Session validation
├── lib/
│   ├── firebase.ts         # Firebase client SDK
│   ├── firebase-admin.ts   # Firebase Admin SDK
│   └── auth-context.tsx    # Auth context + whitelist logic
├── components/
│   ├── Navbar.tsx
│   ├── Mode1Form.tsx       # Text-to-Video form
│   ├── Mode2Form.tsx       # Face Motion form
│   ├── VideoGallery.tsx    # Video list with player/download
│   ├── VoicePreview.tsx    # Thai voice selector with preview
│   └── ProcessingOverlay.tsx
└── types/
    └── index.ts            # Types, voices, models, helpers
```

---

## 🚀 Setup

### 1. Clone & Install

```bash
git clone <repo-url>
cd ai-video-platform
npm install
```

### 2. Firebase Setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication** → Google provider
3. Enable **Cloud Firestore**
4. Enable **Cloud Storage**
5. Generate a service account key (Project Settings → Service Accounts)

### 3. Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```bash
cp .env.example .env.local
```

### 4. Initialize Database

```bash
npx tsx scripts/firebase-setup.ts
```

This creates:
- Whitelist user documents in `users` collection
- Admin config in `admin_config` collection

### 5. Deploy Security Rules

```bash
firebase deploy --only firestore:rules,storage
```

### 6. Create Firestore Indexes

Go to Firebase Console → Firestore → Indexes and create:
- `generations`: `user_email` ASC + `created_at` DESC
- `generations`: `expires_at` ASC

### 7. Run

```bash
npm run dev
```

---

## 🔧 API Keys Required

| Service        | Get Key From                                              |
|----------------|-----------------------------------------------------------|
| Firebase       | [Firebase Console](https://console.firebase.google.com)   |
| Fal.ai         | [fal.ai/dashboard](https://fal.ai/dashboard)             |
| Azure Speech   | [Azure Portal](https://portal.azure.com) → Cognitive Services |

---

## 📋 Firebase Schema

### `users` collection

```typescript
{
  email: string,        // Document ID = email
  is_admin: boolean,
  display_name?: string,
  last_login: Timestamp,
  expires_at: Timestamp, // 12h from last login
}
```

### `generations` collection

```typescript
{
  user_email: string,
  mode: 'text-to-video' | 'face-motion',
  script_text: string,
  situation_prompt: string,
  model_name: string,
  voice_id: string,
  image_url: string,
  video_url: string,
  storage_path: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  aspect_ratio?: string,
  duration_estimate?: number,
  created_at: Timestamp,
  expires_at: Timestamp, // 24h retention
}
```

### `admin_config` collection

```typescript
{
  mode1_enabled: boolean,
  mode2_enabled: boolean,
  max_daily_generations: number,
}
```

---

## 🔒 Security

- **Whitelist Auth**: Only emails in the `users` collection can sign in
- **Session Expiry**: 12-hour sessions, auto-logout on expiry
- **Data Isolation**: Firestore rules enforce per-user data access
- **Storage Rules**: Users can only access their own files
- **Data Retention**: Auto-delete after 24 hours (via cleanup endpoint)
- **Admin-Only Mode 2**: Face Motion restricted to `is_admin: true`

---

## 🧹 Automatic Cleanup

Set up a cron job to call the cleanup endpoint:

```bash
# Every hour
curl -X POST https://your-domain.com/api/cleanup \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Or use Vercel Cron Jobs in `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cleanup",
    "schedule": "0 * * * *"
  }]
}
```

---

## 📄 License

Private — For authorized educational institutions only.

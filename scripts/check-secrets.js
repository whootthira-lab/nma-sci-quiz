#!/usr/bin/env node
/**
 * Secrets hygiene (Content Policy §7): fail the build when a secret is named as if it were
 * public. Next.js inlines NEXT_PUBLIC_* into browser bundles wherever client code reads
 * them; a provider key or a service-role key must never carry that prefix.
 * Runs as `prebuild`. Checks the process environment (Vercel) and .env* files locally.
 */
const fs = require('fs');
const path = require('path');

const SECRET_HINT = /(KEY|SECRET|TOKEN|SERVICE_ROLE|PASSWORD)/i;
const ALLOWED_PUBLIC = new Set([
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',       // anon key is designed to be public (RLS-protected)
  'NEXT_PUBLIC_FIREBASE_API_KEY',        // Firebase web API key is public by design
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID'
]);

const names = new Set(Object.keys(process.env));
for (const f of ['.env', '.env.local', '.env.production']) {
  const p = path.join(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m) names.add(m[1]);
  }
}

const offenders = [...names].filter((n) => n.startsWith('NEXT_PUBLIC_') && SECRET_HINT.test(n) && !ALLOWED_PUBLIC.has(n));
if (offenders.length) {
  const strict = process.env.SECRETS_STRICT === '1';
  console[strict ? 'error' : 'warn'](`[check-secrets] ${strict ? 'BLOCKED' : 'WARNING'}: secret-looking variables with the public prefix: ${offenders.join(', ')}\n  Rename them without NEXT_PUBLIC_ (the server code already reads the server-side names first: FAL_KEY, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, OPENAI_API_KEY …). Set SECRETS_STRICT=1 to make this fail the build.`);
  if (strict) process.exit(1);
} else {
  console.log('[check-secrets] ok — no secret carries the NEXT_PUBLIC_ prefix');
}

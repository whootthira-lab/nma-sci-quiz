import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Server-side session verification. Every API route used to trust the `user_email` the
 * browser put in the body or query. Now the browser also sends its Supabase access token
 * (Authorization: Bearer …, added by the fetch interceptor in auth-context), the server
 * asks Supabase who the token belongs to, and a claimed email that does not match is
 * refused — unless the caller is staff acting on another account (admin/reviewer routes).
 *
 * Rollout: `SESSION_STRICT=1` refuses requests without a token. Until it is set, a missing
 * token is allowed and logged, so nothing breaks while the interceptor reaches every client;
 * a PRESENT token is always verified and a mismatch is always refused.
 */
export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Caller {
  email: string;        // the email the route should act as
  userId?: string;
  role: 'user' | 'reviewer' | 'admin';
  verified: boolean;    // true when a valid token backed the email
}

const SUPER_ADMIN = 'whootthira@gmail.com';

function service() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key);
}

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/**
 * Verify the caller. `claimedEmail` is what the request body/query says; `opts.allowStaffActingAs`
 * lets an admin/reviewer pass a different email (they act on other accounts).
 */
export async function assertCaller(req: NextRequest, claimedEmail: string | null | undefined, opts: { allowStaffActingAs?: boolean } = {}): Promise<Caller> {
  const claimed = (claimedEmail || '').trim().toLowerCase();
  const token = bearer(req);
  const strict = process.env.SESSION_STRICT === '1';

  if (!token) {
    if (strict) throw new AuthError(401, 'ต้องเข้าสู่ระบบก่อน (ไม่พบ session)');
    if (claimed) console.warn(`[auth] unverified request as ${claimed} → ${req.nextUrl.pathname}`);
    return { email: claimed, role: claimed === SUPER_ADMIN ? 'admin' : 'user', verified: false };
  }

  const sb = service();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user?.email) throw new AuthError(401, 'session ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const actual = data.user.email.toLowerCase();
  let role: Caller['role'] = actual === SUPER_ADMIN ? 'admin' : 'user';
  if (role !== 'admin') {
    const { data: prof } = await sb.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
    if (prof?.role === 'admin' || prof?.role === 'reviewer') role = prof.role;
  }
  if (claimed && claimed !== actual) {
    const staff = role === 'admin' || role === 'reviewer';
    if (!(opts.allowStaffActingAs && staff)) {
      console.warn(`[auth] REFUSED: token=${actual} claimed=${claimed} → ${req.nextUrl.pathname}`);
      throw new AuthError(403, 'อีเมลที่ระบุไม่ตรงกับบัญชีที่เข้าสู่ระบบ');
    }
  }
  return { email: claimed || actual, userId: data.user.id, role, verified: true };
}

/** Route-friendly form: a NextResponse to return on failure, else the caller. */
export async function guard(req: NextRequest, claimedEmail: string | null | undefined, opts: { allowStaffActingAs?: boolean } = {}): Promise<NextResponse | Caller> {
  try {
    return await assertCaller(req, claimedEmail, opts);
  } catch (e: any) {
    if (e instanceof AuthError) return NextResponse.json({ success: false, error: e.message, auth: true }, { status: e.status });
    return NextResponse.json({ success: false, error: 'ตรวจสอบ session ไม่สำเร็จ' }, { status: 500 });
  }
}

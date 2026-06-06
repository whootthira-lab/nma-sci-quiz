import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email) {
      return NextResponse.json(
        { valid: false, error: 'No email provided' },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const isSuperAdmin = email === 'whootthira@gmail.com';

    // Check whitelist
    const { data: whitelistData, error: whitelistError } = await supabase
      .from('whitelist')
      .select('email')
      .eq('email', email)
      .single();

    if (whitelistError && !isSuperAdmin) {
      return NextResponse.json({ valid: false, error: 'User not whitelisted' });
    }

    // Check profile
    const { data: profileData } = await supabase
      .from('profiles')
      .select('role')
      .eq('email', email)
      .single();

    return NextResponse.json({
      valid: true,
      is_admin: profileData?.role === 'admin' || isSuperAdmin,
    });
  } catch (error: any) {
    console.error('Auth check error:', error);
    return NextResponse.json(
      { valid: false, error: error.message },
      { status: 500 }
    );
  }
}
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const sfKey = process.env.SILICONFLOW_API_KEY || process.env.NEXT_PUBLIC_SILICONFLOW_API_KEY || '';
    
    if (!sfKey) {
      return NextResponse.json({
        success: false,
        message: 'No SILICONFLOW_API_KEY environment variable detected in Next.js backend.'
      });
    }

    // Safely mask the key for display
    const visibleLength = 5;
    const maskedKey = sfKey.length > visibleLength
      ? sfKey.substring(0, visibleLength) + '...' + sfKey.substring(sfKey.length - 3)
      : 'Short key: ' + sfKey;

    // Test connectivity to SiliconFlow
    console.log('[Diagnostic] Testing API key connection to SiliconFlow...');
    const res = await fetch('https://api.siliconflow.cn/v1/user/info', {
      headers: {
        'Authorization': `Bearer ${sfKey}`
      }
    });

    const status = res.status;
    let data;
    try {
      data = await res.json();
    } catch (e) {
      data = await res.text();
    }

    return NextResponse.json({
      success: status === 200,
      loaded: true,
      keyLength: sfKey.length,
      maskedKey: maskedKey,
      siliconFlowResponseStatus: status,
      siliconFlowResponseBody: data
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Internal Server Error'
    }, { status: 500 });
  }
}

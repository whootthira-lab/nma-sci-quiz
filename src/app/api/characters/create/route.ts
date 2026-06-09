import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const characterData = await req.json();
    
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || '';
    
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[Create Character API] Missing Supabase config env variables.');
      return NextResponse.json(
        { success: false, error: 'Missing database configuration.' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the profile matching the user's email
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', characterData.user_email)
      .single();

    if (profileError || !profile) {
      console.error('[Create Character API] Profile not found for email:', characterData.user_email, profileError);
      return NextResponse.json(
        { success: false, error: `Profile not found for email: ${characterData.user_email}` },
        { status: 404 }
      );
    }

    // Insert character
    const { data, error } = await supabase
      .from('characters')
      .insert({
        user_id: profile.id,
        name: characterData.name,
        code: characterData.code,
        visual_description: characterData.visual_description,
        negative_prompt: characterData.negative_prompt || null,
        avatar_front_url: characterData.avatar_front_url || null,
        avatar_front_path: characterData.avatar_front_path || null,
        avatar_45_url: characterData.avatar_45_url || null,
        avatar_45_path: characterData.avatar_45_path || null,
        avatar_side_url: characterData.avatar_side_url || null,
        avatar_side_path: characterData.avatar_side_path || null,
        lora_status: characterData.lora_status || 'not_started',
        lora_job_id: characterData.lora_job_id || null,
        lora_model_url: characterData.lora_model_url || null,
        lora_trigger_word: characterData.lora_trigger_word || null,
        lora_dataset_url: characterData.lora_dataset_url || null,
        lora_dataset_path: characterData.lora_dataset_path || null,
        lora_steps: characterData.lora_steps || 1000
      })
      .select('*')
      .single();

    if (error) {
      console.error('[Create Character API] Error inserting character:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('[Create Character API Error]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}

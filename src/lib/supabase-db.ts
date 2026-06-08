import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null as any;

// ─── Whitelist Helpers ──────────────────────────────

export async function checkWhitelistUser(email: string) {
  // Query profiles to check if the user is registered (meaning whitelisted and signed up)
  // or query whitelist table directly if they are just logging in.
  const { data, error } = await supabase
    .from('whitelist')
    .select('email')
    .eq('email', email)
    .single();

  if (error || !data) {
    // If not in whitelist, check if they are the super admin
    if (email === 'whootthira@gmail.com') {
      return { email, role: 'admin', is_admin: true };
    }
    return null;
  }

  // Also fetch profile role if they already signed up
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('email', email)
    .single();

  return {
    email: data.email,
    is_admin: profile?.role === 'admin' || email === 'whootthira@gmail.com'
  };
}

export async function updateUserLogin(email: string) {
  // In Supabase, we don't strictly need to track last login session in table
  // because Supabase Auth handles it. However, we can update the updated_at timestamp
  // or store it in profiles.
  const { data: user } = await supabase.auth.getUser();
  if (user?.user) {
    await supabase
      .from('profiles')
      .update({ created_at: new Date().toISOString() }) // updates profile active timestamp
      .eq('id', user.user.id);
  }
}

export async function isSessionValid(email: string): Promise<boolean> {
  // Supabase Auth handles session validation automatically.
  // We return true as long as the user session exists.
  const { data: { session } } = await supabase.auth.getSession();
  return !!session;
}

// ─── Generation Helpers ─────────────────────────────

export async function createGeneration(data: Record<string, any>) {
  // Get user profile first
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', data.user_email)
    .single();

  if (profileError || !profile) {
    throw new Error(`Profile not found for email: ${data.user_email}`);
  }

  const { data: inserted, error } = await supabase
    .from('generations')
    .insert({
      user_id: profile.id,
      prompt: data.situation_prompt || data.script_text || 'AI Generation',
      audio_prompt: data.audio_url || null,
      source_image_url: data.image_url,
      status: data.status || 'pending',
      fal_request_id: data.fal_request_id || null,
      video_url: data.video_url || null,
      metadata: {
        mode: data.mode,
        script_text: data.script_text || '',
        situation_prompt: data.situation_prompt || '',
        model_name: data.model_name || '',
        voice_id: data.voice_id || '',
        aspect_ratio: data.aspect_ratio || '16:9',
        duration_estimate: data.duration_estimate || 0,
        storage_path: data.storage_path || '',
        image_path: data.image_path || '',
        audio_path: data.audio_path || ''
      }
    })
    .select('id')
    .single();

  if (error) throw error;
  return inserted.id;
}

export async function getUserGenerations(email: string) {
  const { data, error } = await supabase
    .from('generations')
    .select('*, profiles!inner(email)')
    .eq('profiles.email', email)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching generations:', error);
    return [];
  }

  return data.map((row: any) => ({
    id: row.id,
    user_email: email,
    mode: row.metadata?.mode || 'text-to-video',
    script_text: row.metadata?.script_text || '',
    situation_prompt: row.metadata?.situation_prompt || '',
    model_name: row.metadata?.model_name || '',
    voice_id: row.metadata?.voice_id || '',
    image_url: row.source_image_url,
    video_url: row.video_url,
    storage_path: row.metadata?.storage_path || '',
    status: row.status,
    created_at: { toDate: () => new Date(row.created_at) }, // Mock Firebase Timestamp toDate() function
    expires_at: { toDate: () => new Date(new Date(row.created_at).getTime() + 24 * 60 * 60 * 1000) },
    aspect_ratio: row.metadata?.aspect_ratio || '16:9',
    duration_estimate: row.metadata?.duration_estimate || 0,
  }));
}

export async function deleteGeneration(id: string, storagePath: string) {
  // 1. Fetch generation to check metadata
  const { data: gen } = await supabase
    .from('generations')
    .select('video_url, metadata')
    .eq('id', id)
    .single();

  // 2. Delete from DB
  const { error: dbError } = await supabase
    .from('generations')
    .delete()
    .eq('id', id);

  if (dbError) throw dbError;

  // 3. Delete files from Storage if they exist
  if (gen) {
    const isFirebase = gen.metadata?.storage_provider === 'firebase' || gen.video_url?.includes('firebasestorage');

    if (storagePath) {
      if (isFirebase) {
        try {
          const { storage: firebaseStorage } = await import('./firebase');
          const { ref, deleteObject } = await import('firebase/storage');
          const fileRef = ref(firebaseStorage, storagePath);
          await deleteObject(fileRef);
        } catch (e) {
          console.warn('Firebase Storage file deletion failed:', storagePath, e);
        }
      } else {
        try {
          await supabase.storage.from('kruth-ai-assets').remove([storagePath]);
        } catch (e) {
          console.warn('Supabase Storage file deletion failed:', storagePath, e);
        }
      }
    }

    // Clean up input files from Supabase Storage (always stored in Supabase)
    const pathsToDelete: string[] = [];
    if (gen.metadata?.image_path) pathsToDelete.push(gen.metadata.image_path);
    if (gen.metadata?.audio_path) pathsToDelete.push(gen.metadata.audio_path);
    if (gen.metadata?.driving_path) pathsToDelete.push(gen.metadata.driving_path);

    if (pathsToDelete.length > 0) {
      try {
        await supabase.storage.from('kruth-ai-assets').remove(pathsToDelete);
      } catch (e) {
        console.warn('Cleanup of input files from Supabase failed:', pathsToDelete, e);
      }
    }
  }
}

// ─── Storage Helpers ────────────────────────────────

export async function uploadToStorage(
  file: File | Blob,
  path: string
): Promise<string> {
  const { data, error } = await supabase.storage
    .from('kruth-ai-assets')
    .upload(path, file, {
      upsert: true,
      contentType: file.type
    });

  if (error) throw error;

  // Get Public URL
  const { data: { publicUrl } } = supabase.storage
    .from('kruth-ai-assets')
    .getPublicUrl(path);

  return publicUrl;
}

export async function uploadBufferToStorage(
  buffer: ArrayBuffer,
  path: string,
  contentType: string
): Promise<string> {
  const blob = new Blob([buffer], { type: contentType });
  return uploadToStorage(blob, path);
}

// ─── Character Helpers ──────────────────────────────

export async function getCharacters(email: string) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (profileError || !profile) {
    console.warn('Profile not found for email when fetching characters:', email);
    return [];
  }

  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching characters:', error);
    return [];
  }

  return data;
}

export async function createCharacter(characterData: Record<string, any>) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', characterData.user_email)
    .single();

  if (profileError || !profile) {
    throw new Error(`Profile not found for email: ${characterData.user_email}`);
  }

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
      avatar_side_path: characterData.avatar_side_path || null
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCharacter(id: string) {
  const { data: character } = await supabase
    .from('characters')
    .select('*')
    .eq('id', id)
    .single();

  if (!character) return;

  const { error: dbError } = await supabase
    .from('characters')
    .delete()
    .eq('id', id);

  if (dbError) throw dbError;

  const pathsToDelete: string[] = [];
  if (character.avatar_front_path) pathsToDelete.push(character.avatar_front_path);
  if (character.avatar_45_path) pathsToDelete.push(character.avatar_45_path);
  if (character.avatar_side_path) pathsToDelete.push(character.avatar_side_path);

  if (pathsToDelete.length > 0) {
    try {
      await supabase.storage.from('kruth-ai-assets').remove(pathsToDelete);
    } catch (e) {
      console.warn('Cleanup of character avatar files from storage failed:', pathsToDelete, e);
    }
  }
}

// ─── Cleanup ────────────────────────────────────────

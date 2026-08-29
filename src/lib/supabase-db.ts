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
  // maybeSingle so that "no row" comes back as data:null with NO error — a real error here
  // means the lookup itself failed (network drop, timeout) and MUST NOT read as "not
  // whitelisted": the auth layer signs people out over that answer, and this check re-runs
  // on every token refresh, so one bad moment of connectivity was ejecting active users.
  const { data, error } = await supabase
    .from('whitelist')
    .select('email, display_name, expires_at, generation_limit')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    throw new Error(`whitelist lookup failed: ${error.message}`);
  }

  if (!data) {
    // If not in whitelist, check if they are the super admin
    if (email === 'whootthira@gmail.com') {
      return { 
        email, 
        role: 'admin', 
        is_admin: true,
        display_name: 'Super Admin',
        expires_at: null,
        generation_limit: 99999
      };
    }
    return null;
  }

  // Also fetch profile role if they already signed up (best-effort: role only affects
  // which menus render, so a failed read must not fail the whole check)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('email', email)
    .maybeSingle();

  return {
    email: data.email,
    display_name: data.display_name,
    expires_at: data.expires_at,
    generation_limit: data.generation_limit,
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
    // The actual generation prompt: images store it in the top-level `prompt` column,
    // videos in metadata.situation_prompt; fall back to the speech script.
    prompt: row.prompt || row.metadata?.situation_prompt || row.metadata?.script_text || '',
    script_text: row.metadata?.script_text || '',
    situation_prompt: row.metadata?.situation_prompt || '',
    model_name: row.metadata?.model_name || '',
    model_endpoint: row.metadata?.model_endpoint || '',
    voice_id: row.metadata?.voice_id || '',
    image_url: row.source_image_url,
    video_url: row.video_url,
    storage_path: row.metadata?.storage_path || '',
    status: row.status,
    created_at: { toDate: () => new Date(row.created_at) }, // Mock Firebase Timestamp toDate() function
    expires_at: { toDate: () => new Date(new Date(row.created_at).getTime() + 24 * 60 * 60 * 1000) },
    aspect_ratio: row.metadata?.aspect_ratio || '16:9',
    duration_estimate: row.metadata?.duration_estimate || 0,
    metadata: row.metadata || {}, // everything "สร้างอีกครั้ง" needs to refill the form
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

/** A failed request often answers in plain text, and parsing that as JSON buries the reason. */
async function readJson(res: Response, fallback: string) {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    const hint = /entity too large|413/i.test(body) || res.status === 413
      ? 'ไฟล์ใหญ่เกินกว่าที่เซิร์ฟเวอร์รับได้'
      : body.slice(0, 120).trim();
    throw new Error(`${fallback}${hint ? ` (${hint})` : ''}`);
  }
}

export async function uploadToStorage(
  file: File | Blob,
  path: string
): Promise<string> {
  const asFile = file instanceof File ? file : new File([file], 'upload.png', { type: file.type });

  // The browser cannot write to the bucket on its own — its rules refuse the write — so
  // the server issues a one-shot permit for this exact filename and the photo then goes
  // straight to storage. Sending the bytes through the server instead would cap them at
  // ~4.5 MB, which an ordinary phone photo passes without trouble.
  try {
    const signRes = await fetch('/api/characters/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const signed = await readJson(signRes, 'ขอสิทธิ์อัปโหลดไม่สำเร็จ');
    if (signed.success && signed.token) {
      const { error } = await supabase.storage
        .from('kruth-ai-assets')
        .uploadToSignedUrl(path, signed.token, asFile, { contentType: asFile.type || 'image/png' });
      if (error) throw error;
      return signed.url as string;
    }
  } catch (err) {
    console.warn('[uploadToStorage] direct upload unavailable, relaying through server:', err);
  }

  // Fallback for when no permit could be issued. Small files only, by the limit above.
  const formData = new FormData();
  formData.append('file', asFile);
  formData.append('path', path);

  const res = await fetch('/api/characters/upload', { method: 'POST', body: formData });
  const json = await readJson(res, 'อัปโหลดรูปไม่สำเร็จ');
  if (!json.success) throw new Error(json.error || 'อัปโหลดรูปไม่สำเร็จ');
  return json.url as string;
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
  // Permission lives on the server: a character carries someone's face, so the caller
  // gets their own, the ones shared with their address, and everything only if admin.
  try {
    const res = await fetch(`/api/characters/access?email=${encodeURIComponent(email)}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'load failed');
    return json.characters || [];
  } catch (err) {
    console.error('Error fetching characters:', err);
    return [];
  }
}

export async function createCharacter(characterData: Record<string, any>) {
  const response = await fetch('/api/characters/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(characterData),
  });

  const resData = await response.json();
  if (!response.ok || !resData.success) {
    throw new Error(resData.error || 'Failed to create character');
  }

  return resData.data;
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

  const parsePaths = (val: string | null): string[] => {
    if (!val) return [];
    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        return JSON.parse(val);
      } catch (e) {
        return [val];
      }
    }
    return [val];
  };

  const pathsToDelete: string[] = [];
  pathsToDelete.push(...parsePaths(character.avatar_front_path));
  pathsToDelete.push(...parsePaths(character.avatar_45_path));
  pathsToDelete.push(...parsePaths(character.avatar_side_path));
  if (character.lora_dataset_path) pathsToDelete.push(character.lora_dataset_path);

  if (pathsToDelete.length > 0) {
    try {
      await supabase.storage.from('kruth-ai-assets').remove(pathsToDelete);
    } catch (e) {
      console.warn('Cleanup of character avatar files from storage failed:', pathsToDelete, e);
    }
  }
}

// ─── Cleanup ────────────────────────────────────────

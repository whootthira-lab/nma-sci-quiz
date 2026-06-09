const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    let val = parts.slice(1).join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
  return env;
}

const env = loadEnv();
const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Listing all tables in schema public...');
  // We can query postgrest for table information or run a rpc or raw query if we can, 
  // but let's try calling select from information_schema via standard HTTP REST if possible.
  // Actually, we can run a raw sql query via standard supabase client if we have an rpc, or we can use REST interface.
  // Or we can try selecting from common tables:
  const tables = ['profiles', 'whitelist', 'generations', 'characters', 'system_settings', 'users'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (error) {
      console.log(`Table '${table}' -> ERROR: ${error.message} (${error.code})`);
    } else {
      console.log(`Table '${table}' -> EXISTS`);
    }
  }
}

main().catch(console.error);

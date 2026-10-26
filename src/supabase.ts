import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL ou VITE_SUPABASE_ANON_KEY manquant (fichier .env.local ou variables GitHub).');
}

export const supabase = createClient(url, key, {
  auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true },
});

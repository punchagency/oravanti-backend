import { createClient } from '@supabase/supabase-js';
import { env } from './env';

const supabaseUrl      = env.SUPABASE_URL;
const supabaseAnonKey  = env.SUPABASE_ANON_KEY;
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Service role client — for admin auth operations (password updates, MFA status checks)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// User-scoped client — for MFA enroll/verify/unenroll (requires user's own token)
export const createUserClient = (accessToken: string) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

import { createClient } from '@supabase/supabase-js';

const supabaseUrl      = process.env.SUPABASE_URL!;
const supabaseAnonKey  = process.env.SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

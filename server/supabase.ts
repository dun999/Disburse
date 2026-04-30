import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.js";

let adminClient: SupabaseClient | undefined;

export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new HttpError(503, "Supabase server environment variables are not configured.");
  }

  adminClient ??= createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return adminClient;
}

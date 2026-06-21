import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    auth: { persistSession: false }
  }
);

export async function upsertSessionStatus(
  businessSlug: string,
  status: string,
  extra: Record<string, string | null> = {}
) {
  const payload: Record<string, unknown> = {
    business_slug: businessSlug,
    status,
    updated_at: new Date().toISOString(),
    ...extra
  };

  const { error } = await supabase
    .from("whatsapp_sessions")
    .upsert(payload, { onConflict: "business_slug" });

  if (error) console.error("Supabase session status error:", error.message);
}

export async function saveMessage(payload: Record<string, unknown>) {
  const { error } = await supabase.from("whatsapp_messages").insert(payload);
  if (error) {
    console.error("Supabase save message error:", error.message);
    console.error(payload);
  }
}

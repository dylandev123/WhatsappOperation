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

// Postgres unique_violation. whatsapp_messages_dedupe_idx (a partial unique
// index on (business_slug, whatsapp_message_id) where whatsapp_message_id is
// not null) enforces dedupe at the DB level; a plain insert of a message
// already saved (live + history import can both see the same message, or a
// relink re-imports an overlapping window) hits this and should be treated
// as "already saved", not an error.
const DUPLICATE_MESSAGE_ERROR_CODE = "23505";

export async function saveMessage(payload: Record<string, unknown>) {
  const { error } = await supabase.from("whatsapp_messages").insert(payload);
  if (error) {
    if (error.code === DUPLICATE_MESSAGE_ERROR_CODE) return;
    console.error("Supabase save message error:", error.message);
    console.error(payload);
  }
}

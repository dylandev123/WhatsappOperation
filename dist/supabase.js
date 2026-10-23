"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.upsertSessionStatus = upsertSessionStatus;
exports.saveMessage = saveMessage;
exports.isSupabaseReachable = isSupabaseReachable;
exports.countStaleMessages = countStaleMessages;
exports.deleteStaleMessages = deleteStaleMessages;
const supabase_js_1 = require("@supabase/supabase-js");
const config_js_1 = require("./config.js");
exports.supabase = (0, supabase_js_1.createClient)(config_js_1.config.supabaseUrl, config_js_1.config.supabaseServiceRoleKey, {
    auth: { persistSession: false }
});
async function upsertSessionStatus(businessSlug, status, extra = {}) {
    const payload = {
        business_slug: businessSlug,
        status,
        updated_at: new Date().toISOString(),
        ...extra
    };
    const { error } = await exports.supabase
        .from("whatsapp_sessions")
        .upsert(payload, { onConflict: "business_slug" });
    if (error)
        console.error("Supabase session status error:", error.message);
}
// Postgres unique_violation. whatsapp_messages_dedupe_idx (a partial unique
// index on (business_slug, whatsapp_message_id) where whatsapp_message_id is
// not null) enforces dedupe at the DB level; a plain insert of a message
// already saved (live + history import can both see the same message, or a
// relink re-imports an overlapping window) hits this and should be treated
// as "already saved", not an error.
const DUPLICATE_MESSAGE_ERROR_CODE = "23505";
async function saveMessage(payload) {
    const { error } = await exports.supabase.from("whatsapp_messages").insert(payload);
    if (error) {
        if (error.code === DUPLICATE_MESSAGE_ERROR_CODE)
            return;
        console.error("Supabase save message error:", error.message);
        console.error(payload);
    }
}
// Pre-delete guard for the retention job (retention.ts), used to gate BOTH
// local media cleanup and whatsapp_messages row cleanup. Checks whatsapp_sessions
// (general connectivity) and customers (the durable profile/memory table —
// see the "profiles are independent of whatsapp_messages" note above
// deleteStaleMessages()) — if either is unreachable, retention.ts aborts
// every deletion for the run rather than guessing.
async function isSupabaseReachable() {
    const [sessions, customers] = await Promise.all([
        exports.supabase.from("whatsapp_sessions").select("business_slug").limit(1),
        exports.supabase.from("customers").select("id").limit(1)
    ]);
    return !sessions.error && !customers.error;
}
// whatsapp_messages has no foreign key referencing it anywhere in the schema
// (customers, conversation_status, conversation_analysis, etc. all key off
// (business_slug, chat_id)/phone_number, never whatsapp_messages.id — see
// the inbox repo's migrations, e.g. 20260623000700_conversation_status.sql:
// "Archive / Spam for conversations, without ever touching whatsapp_messages").
// So deleting old message rows cannot cascade into or otherwise affect
// customer profiles, AI profile data, or conversation metadata — those are
// structurally independent of this table's row lifetime.
async function countStaleMessages(cutoffIso) {
    const { count, error } = await exports.supabase
        .from("whatsapp_messages")
        .select("id", { count: "exact", head: true })
        .lt("timestamp", cutoffIso);
    if (error) {
        console.error("Supabase count stale messages error:", error.message);
        return null;
    }
    return count ?? 0;
}
async function deleteStaleMessages(cutoffIso) {
    // Count first (cheap HEAD request), then delete with the same filter —
    // avoids asking Postgres/PostgREST to return every deleted row just to
    // report a count, which would be a large payload once the table has
    // months of history. New rows are always inserted with "now" as their
    // timestamp, so nothing can newly qualify as ">7 days old" between the
    // count and the delete below.
    const staleCount = await countStaleMessages(cutoffIso);
    if (staleCount === null) {
        return { deletedCount: 0, error: "failed to count stale messages before delete" };
    }
    if (staleCount === 0) {
        return { deletedCount: 0, error: null };
    }
    const { error } = await exports.supabase.from("whatsapp_messages").delete().lt("timestamp", cutoffIso);
    if (error) {
        return { deletedCount: 0, error: error.message };
    }
    return { deletedCount: staleCount, error: null };
}

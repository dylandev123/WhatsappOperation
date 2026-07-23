"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.upsertSessionStatus = upsertSessionStatus;
exports.saveMessage = saveMessage;
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
async function saveMessage(payload) {
    const { error } = await exports.supabase.from("whatsapp_messages").insert(payload);
    if (error) {
        console.error("Supabase save message error:", error.message);
        console.error(payload);
    }
}

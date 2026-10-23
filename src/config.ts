import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const config = {
  port: Number(process.env.PORT || 3030),
  adminSecret: required("ADMIN_SECRET"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3030}`,
  // Canonical form (matches the app's lib/businessSlug.ts normalizeBusinessSlug):
  // trim -> lowercase -> spaces/hyphens to underscores. This becomes every
  // session key and every business_slug written to whatsapp_messages /
  // whatsapp_sessions, so a mixed-case env value here (e.g. "By_Sea") no
  // longer produces rows the website's exact-match queries can't find.
  businesses: (process.env.BUSINESSES || "dog_food,by_sea,cool_pool,candock")
    .split(",")
    .map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter(Boolean),
  // Scheduled messages executor (scheduler.ts). Off unless explicitly enabled.
  schedulerEnabled: process.env.SCHEDULER_ENABLED === "true",
  schedulerPollMs: positiveInt("SCHEDULER_POLL_MS", 20_000),
  // Conservative pause between recipients of one run.
  schedulerDelayMs: positiveInt("SCHEDULER_DELAY_MS", 8_000),
  // 'sending' rows older than this become 'unknown' and are never retried.
  schedulerStaleSendingMs: positiveInt("SCHEDULER_STALE_SENDING_MS", 120_000),
  schedulerWorkerId: process.env.SCHEDULER_WORKER_ID || `bridge-${process.pid}`,
  // Inbox AI agent bridge (src/agent; contract owned by the inbox repo,
  // docs/ai-agent-bridge-contract.md). Off unless explicitly enabled; even
  // when enabled nothing is sent to WhatsApp unless AGENT_SEND_ENABLED is
  // also true AND the inbox has the business in Assisted mode.
  agentEnabled: process.env.AGENT_ENABLED === "true",
  agentSendEnabled: process.env.AGENT_SEND_ENABLED === "true",
  aiAgentUrl: process.env.AI_AGENT_URL || "",
  aiAgentBridgeSecret: process.env.AI_AGENT_BRIDGE_SECRET || "",
  agentStateFile: process.env.AGENT_STATE_FILE || "./auth/agent-bridge-state.json",
  agentBatchWindowMs: positiveInt("AGENT_BATCH_WINDOW_MS", 10_000),
  agentTickMs: positiveInt("AGENT_TICK_MS", 2_000),
  agentConfigTtlMs: positiveInt("AGENT_CONFIG_TTL_MS", 60_000),
  agentMaxMessageAgeMs: positiveInt("AGENT_MAX_MESSAGE_AGE_MS", 10 * 60_000),
  agentMaxChatRepliesPerHour: positiveInt("AGENT_MAX_CHAT_REPLIES_PER_HOUR", 4),
  agentMaxBusinessSendsPerMinute: positiveInt("AGENT_MAX_BUSINESS_SENDS_PER_MINUTE", 3),
  agentMinSendGapMs: positiveInt("AGENT_MIN_SEND_GAP_MS", 5_000),
  agentMaxForwardAttempts: positiveInt("AGENT_MAX_FORWARD_ATTEMPTS", 3),
  agentUnknownSendHoldMs: positiveInt("AGENT_UNKNOWN_SEND_HOLD_MS", 6 * 60 * 60_000),
  authDir: "./auth",
  mediaDir: "./media"
};

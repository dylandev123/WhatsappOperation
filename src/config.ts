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
  authDir: "./auth",
  mediaDir: "./media"
};

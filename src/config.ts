import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
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
  authDir: "./auth",
  mediaDir: "./media"
};

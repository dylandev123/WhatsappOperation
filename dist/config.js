"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function required(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required env var: ${name}`);
    return value;
}
exports.config = {
    port: Number(process.env.PORT || 3030),
    adminSecret: required("ADMIN_SECRET"),
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3030}`,
    businesses: (process.env.BUSINESSES || "dog_food,by_sea,cool_pool,candock")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    authDir: "./auth",
    mediaDir: "./media"
};

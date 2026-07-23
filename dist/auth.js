"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = requireAdmin;
const config_js_1 = require("./config.js");
function requireAdmin(req, res, next) {
    const secret = req.header("x-admin-secret") || req.query.secret;
    if (secret !== config_js_1.config.adminSecret) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

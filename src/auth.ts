import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const secret = req.header("x-admin-secret") || req.query.secret;
  if (secret !== config.adminSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

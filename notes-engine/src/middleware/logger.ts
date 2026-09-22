import type { Request, Response, NextFunction } from "express";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): Level {
  const l = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (l === "debug" || l === "info" || l === "warn" || l === "error") return l;
  return "info";
}

export function log(levelName: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[levelName] < ORDER[currentLevel()]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level: levelName, msg, ...fields });
  if (levelName === "error" || levelName === "warn") console.error(line);
  else console.log(line);
}

// One JSON line per request: method, path, status, duration. Slow (>1s)
// requests and 4xx/5xx are escalated so they stand out in Render logs.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const base = { method: req.method, path: req.path, status: res.statusCode, ms };
    if (res.statusCode >= 500) log("error", "request", base);
    else if (res.statusCode >= 400) log("warn", "request", base);
    else if (ms > 1000) log("warn", "slow request", base);
    else log("info", "request", base);
  });
  next();
}

// Convenience object so call sites read logger.info(...) etc.
export const logger = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => log("debug", msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => log("info", msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => log("warn", msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => log("error", msg, fields),
};

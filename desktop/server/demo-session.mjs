import { randomBytes, timingSafeEqual } from "node:crypto";

export const demoUsername = "demo@folio.local";
export const demoPassword = "FolioDemo2026";
export const demoStage = "/prototype/immersive-exhibition/light.html";
const defaultDestination = `${demoStage}#gallery`;
const sessionSeconds = 8 * 60 * 60;
const workspacePaths = new Set(["/", "/curator/", "/curator/index.html", demoStage]);

export const isWorkspacePage = pathname => workspacePaths.has(pathname);

function destination(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return defaultDestination;
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.origin !== "http://127.0.0.1" || !isWorkspacePage(url.pathname) || url.pathname === "/") return defaultDestination;
    return url.pathname === demoStage && !url.search && !url.hash ? defaultDestination : url.pathname + url.search + url.hash;
  } catch { return defaultDestination; }
}

function matches(value, expected) {
  if (typeof value !== "string" || value.length > 128) return false;
  const input = Buffer.from(value);
  const reference = Buffer.from(expected);
  return input.length === reference.length && timingSafeEqual(input, reference);
}

export function createDemoSession() {
  const sessions = new Map();
  const cookieName = req => `folio_demo_${req.headers.host.split(":").at(-1)}`;
  const cookie = (req, token, age) => `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`;
  function current(req) {
    const prefix = `${cookieName(req)}=`;
    const token = (req.headers.cookie || "").split(/;\s*/).find(value => value.startsWith(prefix))?.slice(prefix.length);
    const expires = sessions.get(token);
    if (expires > Date.now()) return token;
    if (expires) sessions.delete(token);
    return null;
  }
  return {
    current,
    signIn(req, res, body) {
      if (!matches(body.username, demoUsername) || !matches(body.password, demoPassword)) return null;
      const timestamp = Date.now();
      for (const [token, expires] of sessions) if (expires <= timestamp) sessions.delete(token);
      sessions.delete(current(req));
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, timestamp + sessionSeconds * 1000);
      res.setHeader("Set-Cookie", cookie(req, token, sessionSeconds));
      return destination(body.next);
    },
    signOut(req, res) {
      sessions.delete(current(req));
      res.setHeader("Set-Cookie", cookie(req, "", 0));
    },
  };
}

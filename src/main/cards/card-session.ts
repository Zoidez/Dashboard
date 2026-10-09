/**
 * The per-card Electron session (ARCHITECTURE.md, "The wrapper" 1 and 2).
 * A fresh in-memory partition per card start: nothing persists, nothing is shared with the
 * Dashboard or with other cards. Every request except card://<id>/ is cancelled; the proxy is an
 * unroutable address as a second line; every browser permission is denied.
 */
import { session, type Session } from "electron";
import type { AuditLog } from "../audit.js";

/** RFC 6666 discard-only prefix: connections to it go nowhere. Checked after setup (never DIRECT). */
export const DEAD_PROXY = "[100::1]:9";

export const CARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "manifest-src 'none'",
].join("; ");

let counter = 0;

export async function createCardSession(cardId: string, audit: AuditLog): Promise<Session> {
  // No "persist:" prefix = in-memory. A new partition per start so a restarted card starts clean.
  const ses = session.fromPartition(`card:${cardId}:${++counter}`, { cache: false });
  const own = `card://${cardId}/`;

  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    if (u.startsWith(own) || u.startsWith("data:") || u.startsWith("blob:")) return cb({});
    audit.write(cardId, "blocked-request", `${details.resourceType} ${u.slice(0, 300)}`);
    cb({ cancel: true });
  });

  await ses.setProxy({ mode: "fixed_servers", proxyRules: DEAD_PROXY, proxyBypassRules: "<-loopback>" });
  const probe = await ses.resolveProxy("https://example.com/");
  if (!/^PROXY /.test(probe) || /DIRECT/.test(probe)) throw new Error(`card session proxy did not take effect (${probe})`);

  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    audit.write(cardId, "browser-permission", `request: ${permission}`);
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    audit.write(cardId, "browser-permission", `check: ${permission}`);
    return false;
  });
  ses.setDevicePermissionHandler(() => false);
  // Device pickers: cancel without showing anything.
  ses.on("select-hid-device", (e, _d, cb) => { e.preventDefault(); audit.write(cardId, "browser-permission", "hid device picker"); cb(); });
  ses.on("select-serial-port", (e, _l, _wc, cb) => { e.preventDefault(); audit.write(cardId, "browser-permission", "serial port picker"); cb(""); });
  ses.on("select-usb-device", (e, _d, cb) => { e.preventDefault(); audit.write(cardId, "browser-permission", "usb device picker"); cb(); });
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    audit.write(cardId, "browser-permission", "display media");
    cb({});
  });
  ses.on("will-download", (e) => { audit.write(cardId, "blocked-request", "download"); e.preventDefault(); });
  ses.setSpellCheckerEnabled(false);
  return ses;
}

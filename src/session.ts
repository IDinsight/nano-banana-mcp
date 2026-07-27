/**
 * Per-session settings for the Nano Banana MCP server.
 *
 * The server has exactly three settings that tools can change at runtime
 * (set_model / set_resolution / set_url_lifetime). In stdio mode there is a
 * single client, so a single settings object is fine. In HTTP mode (see
 * http.ts) many clients share one process, so each MCP session gets its own
 * SessionSettings instance, carried through async calls with AsyncLocalStorage.
 *
 * getSettings() returns the current session's settings when called inside
 * sessionStorage.run(...), and a module-level default instance otherwise —
 * which is exactly the old single-client behavior for stdio mode.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// Supported models — map of friendly name → Gemini model ID
export const KNOWN_MODELS: Record<string, string> = {
  "nano-banana-pro":  "gemini-3-pro-image-preview",     // Highest quality, slower, ~$0.09/img
  "nano-banana-2":    "gemini-3.1-flash-image-preview",  // Newest Flash model, 4K capable
  "nano-banana":      "gemini-2.5-flash-image",          // Original Flash, fast & cheap
};

/** The three runtime-mutable settings, scoped to one MCP session. */
export interface SessionSettings {
  /** The active model — starts as Flash (nano-banana-2), changeable via set_model. */
  currentModel: string;
  /** The active resolution — API supports only 1K/2K/4K. Starts at 1K (smallest). */
  currentResolution: string;
  /** Signed-URL lifetime (minutes) — changeable via set_url_lifetime. */
  signedUrlMinutes: number;
}

/** Build a fresh settings object with the same defaults the server has always used. */
export function createSessionSettings(): SessionSettings {
  return {
    currentModel: KNOWN_MODELS["nano-banana-2"],
    currentResolution: "1K",
    signedUrlMinutes: parseInt(process.env.FIREBASE_SIGNED_URL_MINUTES || "30", 10),
  };
}

/** Carries the active session's settings across async boundaries (HTTP mode). */
export const sessionStorage = new AsyncLocalStorage<SessionSettings>();

// Fallback used outside any session context — i.e. stdio mode, where the whole
// process serves a single client (previous behavior, unchanged).
const defaultSettings = createSessionSettings();

/** Settings for the current session, or the process-wide defaults (stdio mode). */
export function getSettings(): SessionSettings {
  return sessionStorage.getStore() ?? defaultSettings;
}

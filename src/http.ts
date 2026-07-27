#!/usr/bin/env node

/**
 * Streamable HTTP entry point for the Nano Banana MCP server (`node build/http.js`),
 * for central hosting (e.g. Cloud Run). Local stdio mode (`node build/index.js`)
 * is untouched — this file reuses the same tools via buildServer() from index.ts.
 *
 * - MCP Streamable HTTP transport on POST/GET/DELETE /mcp, stateful sessions:
 *   an initialize request creates a session (fresh McpServer + SessionSettings);
 *   later requests are routed by the `mcp-session-id` header; DELETE ends it.
 *   Each request runs inside AsyncLocalStorage.run(settings, ...) so tools like
 *   set_model only affect their own session.
 * - Auth: when SUPABASE_URL is set, /mcp requires a Supabase-issued Bearer JWT,
 *   verified against the project's JWKS (issuer ${SUPABASE_URL}/auth/v1,
 *   audience "authenticated"). OAuth protected-resource metadata is served so
 *   MCP clients can discover the authorization server. Without SUPABASE_URL the
 *   server refuses to start unless ALLOW_UNAUTHENTICATED=1 (local testing only).
 *
 * Env vars: PORT (default 8080), PUBLIC_URL (this server's public base URL, used
 * in OAuth resource metadata), SUPABASE_URL, ALLOW_UNAUTHENTICATED.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, initFirebase, ensureLifecycleRule } from "./index.js";
import { createSessionSettings, sessionStorage, SessionSettings } from "./session.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");

if (!SUPABASE_URL && process.env.ALLOW_UNAUTHENTICATED !== "1") {
  console.error("ERROR: SUPABASE_URL is not set, so Bearer-token auth cannot be enabled.");
  console.error("Refusing to serve /mcp unauthenticated. Either set SUPABASE_URL to your");
  console.error("Supabase project URL (e.g. https://xyzcompany.supabase.co), or set");
  console.error("ALLOW_UNAUTHENTICATED=1 to run WITHOUT auth (local testing only).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth — verify Supabase-issued JWTs against the project's JWKS
// ---------------------------------------------------------------------------

/** OAuthTokenVerifier that validates a Supabase access token (asymmetric JWT). */
function buildSupabaseVerifier(supabaseUrl: string): OAuthTokenVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated" }));
      } catch (err) {
        // Map any verification failure to InvalidTokenError so requireBearerAuth
        // answers 401 (+ WWW-Authenticate) rather than 500.
        throw new InvalidTokenError(err instanceof Error ? err.message : String(err));
      }
      const sub = typeof payload.sub === "string" ? payload.sub : "unknown";
      const email = typeof payload.email === "string" ? payload.email : undefined;
      console.error(`[auth] authenticated request: sub=${sub}${email ? ` email=${email}` : ""}`);
      return {
        token,
        clientId: sub,
        scopes: [],
        expiresAt: payload.exp, // seconds since epoch; requireBearerAuth checks expiry
        extra: { sub, email },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));

// Health check (no auth) — used by Cloud Run and for quick smoke tests.
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

// Middleware applied to /mcp: Bearer auth when Supabase is configured, else none.
const mcpMiddleware: RequestHandler[] = [];
if (SUPABASE_URL) {
  // Advertise OAuth protected-resource metadata so MCP clients can discover the
  // authorization server (Supabase Auth) for this resource (PUBLIC_URL).
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: `${SUPABASE_URL}/auth/v1`,
        authorization_endpoint: `${SUPABASE_URL}/auth/v1/authorize`,
        token_endpoint: `${SUPABASE_URL}/auth/v1/token`,
        jwks_uri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
      resourceServerUrl: new URL(PUBLIC_URL),
      resourceName: "nano-banana-mcp",
    })
  );
  mcpMiddleware.push(
    requireBearerAuth({
      verifier: buildSupabaseVerifier(SUPABASE_URL),
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(PUBLIC_URL)),
    })
  );
  console.error(`[auth] Supabase JWT auth enabled (issuer: ${SUPABASE_URL}/auth/v1)`);
} else {
  console.error("[auth] WARNING: running UNAUTHENTICATED (ALLOW_UNAUTHENTICATED=1) — local testing only");
}

// ---------------------------------------------------------------------------
// Session management — one transport + server + settings per MCP session
// ---------------------------------------------------------------------------

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  settings: SessionSettings;
}

const sessions = new Map<string, SessionEntry>();

// POST /mcp — either an initialize request (creates a session) or a message on
// an existing session (routed by the mcp-session-id header).
app.post("/mcp", ...mcpMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await sessionStorage.run(existing.settings, () =>
        existing.transport.handleRequest(req, res, req.body)
      );
      return;
    }

    if (sessionId || !isInitializeRequest(req.body)) {
      // Unknown session id, or a non-initialize request without one.
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID provided" },
        id: null,
      });
      return;
    }

    // New session: fresh settings + transport + server instance.
    const settings = createSessionSettings();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error(`[mcp] session started: ${sid}`);
        sessions.set(sid, { transport, settings });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.delete(transport.sessionId)) {
        console.error(`[mcp] session closed: ${transport.sessionId}`);
      }
    };
    await buildServer().connect(transport);
    await sessionStorage.run(settings, () => transport.handleRequest(req, res, req.body));
  } catch (err) {
    console.error(`[mcp] request failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp (SSE notification stream) and DELETE /mcp (session termination)
// both require an existing session.
const handleSessionRequest: RequestHandler = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await sessionStorage.run(entry.settings, () => entry.transport.handleRequest(req, res));
};

app.get("/mcp", ...mcpMiddleware, handleSessionRequest);
app.delete("/mcp", ...mcpMiddleware, handleSessionRequest);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await initFirebase();
  await ensureLifecycleRule();
  app.listen(PORT, () => {
    console.error(`Nano Banana Pro MCP server (Streamable HTTP) listening on port ${PORT}`);
    console.error(`  MCP endpoint: ${PUBLIC_URL}/mcp`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

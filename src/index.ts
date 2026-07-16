#!/usr/bin/env node

/**
 * Minimal MCP server for Nano Banana Pro image generation.
 *
 * Exposes five tools:
 *   - set_model: switch between Gemini image models at runtime
 *   - set_resolution: change the default image resolution
 *   - generate_image: create an image from a text prompt
 *   - generate_image_batch: create multiple images from an array of prompts
 *   - edit_image: edit an image (fetched from a URL) with instructions
 *
 * Images are never written to local disk. Each image is returned inline for viewing
 * and, when Firebase Storage is configured, uploaded there with a signed URL returned
 * so it can be pulled into other environments (e.g. to embed in a document).
 *
 * Requires GEMINI_API_KEY. Firebase Storage is optional (see config below).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

/** Expand a leading ~ or ~/ to the user's home directory (env vars aren't shell-expanded). */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  // stderr is safe for logging in stdio MCP servers (stdout is reserved for JSON-RPC)
  console.error("ERROR: GEMINI_API_KEY environment variable is not set.");
  console.error("Get a key at https://aistudio.google.com/apikey");
  process.exit(1);
}

// Supported models — map of friendly name → Gemini model ID
const KNOWN_MODELS: Record<string, string> = {
  "nano-banana-pro":  "gemini-3-pro-image-preview",     // Highest quality, slower, ~$0.09/img
  "nano-banana-2":    "gemini-3.1-flash-image-preview",  // Newest Flash model, 4K capable
  "nano-banana":      "gemini-2.5-flash-image",          // Original Flash, fast & cheap
};

// The active model — starts as Flash (nano-banana-2), changeable at runtime via the set_model tool
let currentModel = KNOWN_MODELS["nano-banana-2"];

// The active resolution — API supports only 1K/2K/4K. Start at 1K (smallest);
// sharp compression (enforceMaxSize) is what actually keeps files small.
let currentResolution = "1K";

// Images are only compressed if they exceed this file size (bytes). Since images are
// no longer returned inline, this is just a cap on the stored file size, not the tool result.
// Override with NANO_BANANA_MAX_IMAGE (in bytes). Default 500KB.
const MAX_IMAGE_BYTES = parseInt(process.env.NANO_BANANA_MAX_IMAGE || "512000", 10);

// ---------------------------------------------------------------------------
// Firebase Storage (optional) — lets images cross into other environments via a URL.
//
// The MCP server uploads each image to a Firebase Storage bucket and hands back a
// time-limited signed URL. Another environment (e.g. Claude's sandbox) can download
// that URL directly — no credentials leave this process, and the bytes never travel
// through the model as text.
//
// Configure with EITHER:
//   (a) a path to the service-account JSON file (recommended):
//       SERVICE_ACCOUNT_KEY_PATH   e.g. "/Users/you/keys/firebase-sa.json"
//       FIREBASE_STORAGE_BUCKET    e.g. "my-project.appspot.com"
//   (b) the individual credential fields (fallback):
//       FIREBASE_STORAGE_BUCKET, FIREBASE_PROJECT_ID,
//       FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// Optional:
//   FIREBASE_SIGNED_URL_MINUTES   signed-URL lifetime in minutes (default 60)
// ---------------------------------------------------------------------------

const SIGNED_URL_MINUTES = parseInt(process.env.FIREBASE_SIGNED_URL_MINUTES || "60", 10);

// firebase-admin is imported lazily only if configured, so the server runs fine without it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let firebaseBucket: any = null;

async function initFirebase(): Promise<void> {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH
    ? expandHome(process.env.SERVICE_ACCOUNT_KEY_PATH)
    : undefined;

  // A bucket name is required to enable uploads; without it the server still runs
  // (images are returned inline only).
  if (!bucketName) {
    console.error("[firebase] disabled — FIREBASE_STORAGE_BUCKET not set (images returned inline only)");
    return;
  }

  try {
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getStorage } = await import("firebase-admin/storage");

    // Build the credential from a key file if provided, else from individual vars.
    let credential;
    if (keyPath) {
      if (!fs.existsSync(keyPath)) {
        console.error(`[firebase] disabled — SERVICE_ACCOUNT_KEY_PATH not found: ${keyPath}`);
        return;
      }
      const sa = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      credential = cert({
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: sa.private_key,
      });
    } else {
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      if (!clientEmail || !privateKey || !projectId) {
        console.error("[firebase] disabled — no SERVICE_ACCOUNT_KEY_PATH and incomplete FIREBASE_* vars");
        return;
      }
      credential = cert({
        projectId,
        clientEmail,
        // Env vars often store the key with literal "\n" — normalize to real newlines.
        privateKey: privateKey.replace(/\\n/g, "\n"),
      });
    }

    if (getApps().length === 0) {
      initializeApp({ credential, storageBucket: bucketName });
    }
    firebaseBucket = getStorage().bucket();
    console.error(`[firebase] enabled (bucket: ${bucketName})`);
  } catch (err) {
    console.error(`[firebase] init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Upload a buffer to Firebase Storage and return a time-limited signed URL.
 * Returns null (and never throws) if Firebase isn't configured or the upload fails.
 */
async function uploadToFirebase(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string | null> {
  if (!firebaseBucket) return null;
  try {
    const objectPath = `nano-banana/${filename}`;
    const file = firebaseBucket.file(objectPath);
    await file.save(buffer, { contentType: mimeType, resumable: false });

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + SIGNED_URL_MINUTES * 60 * 1000,
    });
    return url;
  } catch (err) {
    console.error(`Firebase upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}


// Initialize the Google GenAI client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a timestamped filename like 2026-07-14_143052_a1b2.png */
function makeFilename(prefix: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}_${rand}.png`;
}

/**
 * Build an MCP Apps HTML resource block that renders the image inline in the client.
 * The image is embedded as a data URI (not an external URL) to avoid the widget
 * sandbox CSP that blocks external image domains.
 */
function buildPreviewResource(base64: string, mimeType: string, filename: string) {
  const html =
    `<img src="data:${mimeType};base64,${base64}" ` +
    `alt="generated image" ` +
    `style="max-width:100%;height:auto;display:block;border-radius:8px" />`;
  return {
    type: "resource" as const,
    resource: {
      uri: `ui://nano-banana/${filename}`,
      mimeType: "text/html",
      text: html,
    },
  };
}

/**
 * Compress an image only if it exceeds MAX_IMAGE_BYTES. Images under the threshold are
 * returned untouched (original format preserved). Over the threshold, it steps JPEG quality
 * down, then resizes if needed, until the file fits.
 * Returns { buffer, mimeType } — mimeType becomes image/jpeg only if recompression happened.
 */
async function enforceMaxSize(
  input: Buffer,
  originalMimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Under the size limit — leave it exactly as-is (keeps original format/quality).
  if (input.length <= MAX_IMAGE_BYTES) {
    return { buffer: input, mimeType: originalMimeType };
  }

  // Too large: try decreasing JPEG quality at full dimensions first.
  for (const q of [85, 70, 55, 40, 30]) {
    const buf = await sharp(input).jpeg({ quality: q }).toBuffer();
    if (buf.length <= MAX_IMAGE_BYTES) {
      return { buffer: buf, mimeType: "image/jpeg" };
    }
  }

  // Still too large: resize down in steps.
  const meta = await sharp(input).metadata();
  const longest = Math.max(meta.width || 1024, meta.height || 1024);
  for (let scale = 0.85; scale >= 0.2; scale -= 0.15) {
    const dim = Math.round(longest * scale);
    const buf = await sharp(input)
      .resize(dim, dim, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
    if (buf.length <= MAX_IMAGE_BYTES) {
      return { buffer: buf, mimeType: "image/jpeg" };
    }
  }

  // Last resort.
  const tiny = await sharp(input).resize(512, 512, { fit: "inside" }).jpeg({ quality: 50 }).toBuffer();
  return { buffer: tiny, mimeType: "image/jpeg" };
}

/**
 * Call Gemini's generateContent with image output enabled.
 * Returns { text, imageBase64, mimeType } or throws on failure.
 */
async function callGemini(
  // ContentListUnion accepts: string, Part[], Content[], etc.
  // We use string for text-only prompts, or an array of Part objects for multimodal.
  contents: string | Array<Record<string, unknown>>,
  model: string,
  aspectRatio?: string,
  resolution?: string
): Promise<{ text: string | null; imageBase64: string | null; mimeType: string }> {
  // Build the config — request an image in the response
  const config: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };

  // imageConfig is the correct field for controlling aspect ratio and size.
  // imageSize accepts only "1K", "2K", "4K" (default "1K"). aspectRatio accepts
  // "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9".
  const imageConfig: Record<string, string> = {
    imageSize: resolution || currentResolution,
  };
  if (aspectRatio) {
    imageConfig.aspectRatio = aspectRatio;
  }
  config.imageConfig = imageConfig;

  const response = await ai.models.generateContent({
    model,
    contents,
    config,
  });

  // Extract text and image parts from the response
  let text: string | null = null;
  let imageBase64: string | null = null;
  let mimeType = "image/png";

  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if ((part as { text?: string }).text) {
      text = (part as { text: string }).text;
    }
    if ((part as { inlineData?: { data: string; mimeType: string } }).inlineData) {
      const inline = (part as { inlineData: { data: string; mimeType: string } }).inlineData;
      imageBase64 = inline.data;
      mimeType = inline.mimeType || "image/png";
    }
  }

  return { text, imageBase64, mimeType };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nano-banana-pro",
  version: "1.0.0",
});

// ---- Tool: set_model --------------------------------------------------------

server.registerTool(
  "set_model",
  {
    title: "Set Image Model",
    description:
      "Switch the Gemini image model used by generate_image and edit_image. " +
      "Options: 'nano-banana-pro' (highest quality, ~$0.09/img), " +
      "'nano-banana-2' (newest Flash, 4K capable, ~$0.05/img), " +
      "'nano-banana' (original Flash, fastest, ~$0.04/img). " +
      "You can also pass a raw Gemini model ID directly.",
    inputSchema: z.object({
      model: z
        .string()
        .describe(
          "Model name: 'nano-banana-pro', 'nano-banana-2', 'nano-banana', " +
          "or a raw Gemini model ID like 'gemini-3-pro-image-preview'"
        ),
    }),
  },
  async ({ model }) => {
    // Resolve friendly name → model ID, or accept a raw ID
    const resolvedModel = KNOWN_MODELS[model.toLowerCase()] ?? model;
    const previousModel = currentModel;
    currentModel = resolvedModel;

    // Build a readable label for the response
    const friendlyName =
      Object.entries(KNOWN_MODELS).find(([, id]) => id === resolvedModel)?.[0] ??
      resolvedModel;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Model switched to: ${friendlyName} (${resolvedModel})` +
            (previousModel !== resolvedModel
              ? `\nPrevious model: ${previousModel}`
              : "\n(No change — this model was already active)"),
        },
      ],
    };
  }
);

// ---- Tool: set_resolution ---------------------------------------------------

server.registerTool(
  "set_resolution",
  {
    title: "Set Image Resolution",
    description:
      "Set the source resolution the model generates at, for all subsequent generate/edit calls. " +
      "The API supports '1K' (default), '2K', and '4K'. Note that images are always compressed " +
      "to stay under the size limit regardless — higher values mainly affect source detail, not final file size.",
    inputSchema: z.object({
      resolution: z
        .enum(["1K", "2K", "4K"])
        .describe("Source resolution: '1K' (default), '2K', or '4K'"),
    }),
  },
  async ({ resolution }) => {
    const previous = currentResolution;
    currentResolution = resolution;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Default resolution set to: ${resolution}` +
            (previous !== resolution
              ? `\nPrevious: ${previous}`
              : "\n(No change — already at this resolution)"),
        },
      ],
    };
  }
);

// ---- Tool: generate_image ---------------------------------------------------

server.registerTool(
  "generate_image",
  {
    title: "Generate Image",
    description:
      "Generate an image from a text prompt, upload it to Firebase Storage, and return a signed " +
      "download URL. The image is compressed only if it exceeds the size limit. Nothing is written " +
      "to local disk and the image is not returned inline.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
      aspect_ratio: z
        .string()
        .optional()
        .describe("Aspect ratio, e.g. '1:1', '16:9', '9:16', '4:3'. Defaults to 1:1"),
      resolution: z
        .string()
        .optional()
        .describe("Source resolution: '1K' (default), '2K', or '4K'. Final file is always compressed to stay small"),
    }),
  },
  async ({ prompt, aspect_ratio, resolution }) => {
    try {
      const { text, imageBase64, mimeType } = await callGemini(
        prompt,
        currentModel,
        aspect_ratio,
        resolution
      );

      if (!imageBase64) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The model did not return an image. It may have been blocked by safety filters. " +
                    "Try rephrasing your prompt." +
                    (text ? `\n\nModel response: ${text}` : ""),
            },
          ],
        };
      }

      const rawBuffer = Buffer.from(imageBase64, "base64");

      // Compress only if the file exceeds the size limit.
      const { buffer: imageBuffer, mimeType: finalMime } = await enforceMaxSize(rawBuffer, mimeType);

      // Upload to Firebase Storage and get a signed URL. Nothing is written to local disk.
      const filename = makeFilename("gen");
      const url = await uploadToFirebase(imageBuffer, filename, finalMime);

      const note = url
        ? `Image generated (${(imageBuffer.length / 1024).toFixed(0)} KB).\n` +
          `Download URL (valid ${SIGNED_URL_MINUTES} min):\n${url}`
        : `Image generated, but Firebase Storage is not configured so there is no URL to return. ` +
          `Set SERVICE_ACCOUNT_KEY_PATH and FIREBASE_STORAGE_BUCKET to enable uploads.`;

      // Inline preview (HTML widget with the image as a data URI) + text note with the URL.
      const previewBase64 = imageBuffer.toString("base64");
      return {
        content: [
          buildPreviewResource(previewBase64, finalMime, filename),
          { type: "text" as const, text: note },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Image generation failed: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ---- Tool: generate_image_batch ---------------------------------------------

server.registerTool(
  "generate_image_batch",
  {
    title: "Generate Images (Batch)",
    description:
      "Generate multiple images from an array of prompts in a single call. " +
      "Images are saved to the MCP server's output folder only (NOT your container). " +
      "Use generate_image individually if you need images in your container. " +
      "Returns a text summary with server file paths.",
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            prompt: z.string().describe("Description of the image to generate"),
            aspect_ratio: z
              .string()
              .optional()
              .describe("Aspect ratio, e.g. '1:1', '16:9'. Defaults to 1:1"),
            resolution: z
              .string()
              .optional()
              .describe("Source resolution: '1K' (default), '2K', or '4K'. Final file is always compressed to stay small"),
          })
        )
        .min(1)
        .max(20)
        .describe("Array of image generation requests (1–20 items)"),
    }),
  },
  async ({ items }) => {
    const results: string[] = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const label = `[${i + 1}/${items.length}]`;

      try {
        const { imageBase64, mimeType } = await callGemini(
          item.prompt,
          currentModel,
          item.aspect_ratio,
          item.resolution
        );

        if (!imageBase64) {
          failCount++;
          results.push(`${label} SKIPPED (safety filter) — "${item.prompt}"`);
          continue;
        }

        const rawBuffer = Buffer.from(imageBase64, "base64");
        const { buffer: imageBuffer, mimeType: finalMime } = await enforceMaxSize(rawBuffer, mimeType);

        // Upload to Firebase Storage; no local disk.
        const filename = makeFilename("batch");
        const url = await uploadToFirebase(imageBuffer, filename, finalMime);

        successCount++;
        results.push(
          url
            ? `${label} OK — ${url}\n    Prompt: "${item.prompt}"`
            : `${label} OK but no URL (Firebase not configured) — "${item.prompt}"`
        );
      } catch (err) {
        failCount++;
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${label} FAILED — "${item.prompt}"\n    Error: ${msg}`);
      }
    }

    const summary =
      `Batch complete: ${successCount} succeeded, ${failCount} failed out of ${items.length} total.\n` +
      `Signed URLs valid ${SIGNED_URL_MINUTES} min.\n\n` +
      results.join("\n");

    return {
      content: [{ type: "text" as const, text: summary }],
    };
  }
);

// ---- Tool: edit_image -------------------------------------------------------

server.registerTool(
  "edit_image",
  {
    title: "Edit Image",
    description:
      "Edit an existing image using natural language instructions. " +
      "Provide the URL of the source image (e.g. a URL returned by generate_image) and describe the changes. " +
      "The edited image is uploaded to Firebase Storage and a signed URL is returned. Nothing touches local disk.",
    inputSchema: z.object({
      source_url: z.string().describe("URL of the image to edit (e.g. a signed URL from generate_image)"),
      prompt: z.string().describe("Description of the edits to make"),
      aspect_ratio: z
        .string()
        .optional()
        .describe("Aspect ratio for the output, e.g. '1:1', '16:9'"),
      resolution: z
        .string()
        .optional()
        .describe("Source resolution: '1K' (default), '2K', or '4K'. Final file is always compressed to stay small"),
    }),
  },
  async ({ source_url, prompt, aspect_ratio, resolution }) => {
    try {
      // Fetch the source image over the network — no disk read.
      const resp = await fetch(source_url);
      if (!resp.ok) {
        return {
          content: [{ type: "text" as const, text: `Could not fetch source image (HTTP ${resp.status}).` }],
          isError: true,
        };
      }
      const inputMime = resp.headers.get("content-type") || "image/png";
      const base64Image = Buffer.from(await resp.arrayBuffer()).toString("base64");

      // Build the multimodal content: text instruction + image
      const contents = [
        { text: prompt },
        { inlineData: { mimeType: inputMime, data: base64Image } },
      ];

      const { text, imageBase64, mimeType } = await callGemini(
        contents,
        currentModel,
        aspect_ratio,
        resolution
      );

      if (!imageBase64) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The model did not return an edited image. " +
                    "The edit may have been blocked by safety filters." +
                    (text ? `\n\nModel response: ${text}` : ""),
            },
          ],
        };
      }

      const rawBuffer = Buffer.from(imageBase64, "base64");
      const { buffer: imageBuffer, mimeType: finalMime } = await enforceMaxSize(rawBuffer, mimeType);

      // Upload the edited image; no disk.
      const filename = makeFilename("edit");
      const url = await uploadToFirebase(imageBuffer, filename, finalMime);

      const note = url
        ? `Edited image (${(imageBuffer.length / 1024).toFixed(0)} KB).\n` +
          `Download URL (valid ${SIGNED_URL_MINUTES} min):\n${url}`
        : `Edited image created, but Firebase Storage is not configured so there is no URL to return.`;

      const previewBase64 = imageBuffer.toString("base64");
      return {
        content: [
          buildPreviewResource(previewBase64, finalMime, filename),
          { type: "text" as const, text: note },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Image editing failed: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start the server over stdio
// ---------------------------------------------------------------------------

async function main() {
  await initFirebase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nano Banana Pro MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
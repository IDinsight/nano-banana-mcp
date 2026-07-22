# Nano Banana Pro MCP Server

A minimal, auditable MCP server that gives Claude Desktop the ability to generate and edit images using Google's Gemini image models (Nano Banana / Nano Banana Pro).

All logic lives in `src/index.ts`. No hidden dependencies — read it before you run it.

## What it does

| Tool | Description |
|------|-------------|
| `set_model` | Switch between Gemini image models at runtime |
| `set_resolution` | Set source resolution (`1K` / `2K` / `4K`) |
| `set_url_lifetime` | Set how long download URLs stay valid (default 30 min) |
| `generate_image` | Generate an image from a text prompt |
| `generate_image_batch` | Generate several images from a list of prompts |
| `edit_image` | Edit an image (fetched from a URL) with instructions |

Images are never written to local disk. `generate_image` and `edit_image` return an inline
preview (an MCP Apps HTML widget with the image embedded, rendered in the chat) plus, when
Firebase Storage is configured, a time-limited signed download URL. `generate_image_batch`
returns URLs only (no previews). Another environment (e.g. Claude's sandbox) fetches a URL to
embed the image in a document.

Inline preview rendering depends on the client supporting MCP Apps; if it doesn't render, the
image is still available via the signed URL. Images are compressed only if they exceed the size
threshold (500KB by default); smaller images are kept as-is.

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **Gemini API key** — from [Google AI Studio](https://aistudio.google.com/apikey). Enable billing for image generation (pay-per-image).
- **(Optional) Firebase Storage** — only needed if you want generated images usable outside the chat (see below).

## Setup

### 1. Build

```bash
npm install
npm run build
```

### 2. Configure Claude Desktop

Open the config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nano-banana-pro": {
      "command": "node",
      "args": ["/absolute/path/to/nano-banana-mcp/build/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### 3. Fully quit and reopen Claude Desktop

Use Cmd+Q (not just closing the window) — the config is only read at launch.

## Usage

- *"Generate an image of a Senegalese market at sunset"*
- *"Create a 16:9 hero banner for a blog about climate resilience"*
- *"Switch to nano-banana-pro and generate a 2K product shot"*

## Models

| Friendly name | Model ID | Notes |
|---------------|----------|-------|
| `nano-banana-2` (default) | `gemini-3.1-flash-image-preview` | Fast, good quality |
| `nano-banana-pro` | `gemini-3-pro-image-preview` | Highest quality, slower |
| `nano-banana` | `gemini-2.5-flash-image` | Original flash model |

Switch at runtime with the `set_model` tool (e.g. "use nano-banana-pro").

## Optional: Firebase Storage (use images outside the chat)

Inline previews work without Firebase. Firebase is what makes an image usable *outside* the
chat: each image is uploaded and a signed download URL is returned, which another environment
(e.g. Claude's sandbox) can fetch to embed in a document.

Point at your service-account JSON key file (recommended):

```json
"env": {
  "GEMINI_API_KEY": "your-api-key-here",
  "SERVICE_ACCOUNT_KEY_PATH": "/Users/you/keys/firebase-adminsdk.json",
  "FIREBASE_STORAGE_BUCKET": "your-project.firebasestorage.app"
}
```

- Download the key from Firebase Console → Project Settings → Service Accounts → Generate new private key.
- Copy the bucket name exactly from the Storage page (newer projects use `*.firebasestorage.app`, older ones `*.appspot.com`).
- A leading `~` in the key path is expanded automatically; a full absolute path also works.
- Alternatively supply `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` instead of a key file.
- Optional: `FIREBASE_SIGNED_URL_MINUTES` (default 30) sets the default download-URL lifetime. Change it at runtime with the `set_url_lifetime` tool (accepts 1–10080 minutes, i.e. up to 7 days).
- Optional: `FIREBASE_OBJECT_TTL_DAYS` (default 1) — uploaded images auto-delete after this many days via a bucket lifecycle rule (see below).
- For the download to work, the environment fetching the URL needs outbound access to `storage.googleapis.com`.

### Auto-deletion of stored images

Images are deleted from the bucket automatically after `FIREBASE_OBJECT_TTL_DAYS` days (default 1) so nothing accumulates indefinitely. The server tries to apply this as a bucket lifecycle rule at startup. If the service account lacks permission to update bucket metadata, apply it once manually with the gcloud CLI:

```bash
cat > /tmp/lifecycle.json <<'JSON'
{ "rule": [ { "action": {"type": "Delete"}, "condition": {"age": 1} } ] }
JSON
gcloud storage buckets update gs://YOUR_BUCKET --lifecycle-file=/tmp/lifecycle.json
```

(`age` is in days.) This runs on Google Cloud regardless of whether the MCP server is running.

### Confidentiality notes (important for org rollout)

- Generation sends prompts and receives images via Google's Gemini API; treat prompt content accordingly.
- Download URLs are **signed URLs** — anyone with the link can open the image until it expires (default 30 min). Keep the lifetime short and avoid pasting URLs into shared/persistent places.
- All images share one bucket under one service-account key; there is no per-user separation or audit trail. If your images may be sensitive, review this against your data-handling policy before org-wide use.

### Storage rules

The server authenticates with the Admin SDK, which bypasses Storage rules, and hands out signed URLs that carry their own auth. So you can keep rules fully locked down:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if false; }
  }
}
```

## Knobs

Set in the `env` block if needed:
- `NANO_BANANA_MAX_IMAGE` — max stored file size in bytes; larger images are compressed down (default `512000`, i.e. 500KB). Images under the threshold are stored untouched in their original format.
- `NANO_BANANA_INLINE_PREVIEW` — whether `generate_image`/`edit_image` include an inline image preview by default (`true` by default; set `false` to return URL/text only, which makes responses smaller and faster). Each call can override this with an `inline_preview` argument.
- `NANO_BANANA_TIMEOUT_MS` — per-operation timeout in milliseconds for the Gemini call, Firebase upload, and edit-image fetch (default `60000`). A stuck call fails cleanly with a "timed out" error instead of hanging until the client aborts the turn.

## Security notes

- The Gemini key and Firebase credentials stay in the MCP server process — never sent to Claude or its sandbox (the sandbox only ever sees a plain signed URL).
- Keep the service-account `.json` out of any git repo or synced folder — it's a real credential.
- No telemetry, no analytics.

## License

MIT
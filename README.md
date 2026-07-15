# Nano Banana Pro MCP Server

A minimal, auditable MCP server that gives Claude Desktop the ability to generate and edit images using Google's **Nano Banana Pro** (Gemini 3 Pro Image) model.

~150 lines of TypeScript. No hidden dependencies. You own the code.

## What it does

| Tool | Description |
|------|-------------|
| `set_model` | Switch between Gemini image models |
| `set_resolution` | Set source resolution (1K/2K/4K) |
| `generate_image` | Create an image from a text prompt |
| `generate_image_batch` | Create several images at once |
| `edit_image` | Edit an image (given its URL) with instructions |

Generated images are returned inline (so Claude can display them in chat) and saved to `~/nano-banana-output/`.

> Images are never written to local disk. Each is returned inline for viewing, and — when Firebase Storage is configured — uploaded there with a signed URL you can fetch from other environments (e.g. to embed in a document).

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **Gemini API key** — free from [Google AI Studio](https://aistudio.google.com/apikey). Enable billing for image generation (pay-per-image, no monthly minimum).

## Setup

### 1. Clone and build

```bash
git clone <your-repo-url> nano-banana-mcp
cd nano-banana-mcp
npm install
npm run build
```

### 2. Configure Claude Desktop

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this entry (adjust the path to where you cloned the repo):

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

### 3. Restart Claude Desktop

The server should appear in the MCP tools menu (hammer icon).

## Usage examples

Once connected, just ask Claude naturally:

- *"Generate an image of a Senegalese market at sunset"*
- *"Create a 16:9 hero banner for a blog about climate resilience"*
- *"Edit ~/nano-banana-output/gen_20260714_a1b2.png — remove the background and add a gradient"*

## Models

The server supports two Gemini image models:

| Model | ID | Quality | Speed | Cost |
|-------|-----|---------|-------|------|
| Nano Banana Pro | `gemini-3-pro-image-preview` | Highest | Slower | ~$0.09/image |
| Nano Banana | `gemini-2.5-flash-image` | Good | Fast | ~$0.04/image |

By default, `generate_image` uses Pro. Pass `use_pro: false` to switch to the faster Flash model.

## Security notes

- Your API key stays local — it's passed via environment variable, never logged or transmitted elsewhere.
- The server only makes HTTPS calls to `generativelanguage.googleapis.com` (Google's Gemini API).
- No telemetry, no analytics, no third-party calls.
- All code is in `src/index.ts` — read it before you run it.

## Project structure

```
nano-banana-mcp/
├── src/
│   └── index.ts      ← the entire server (~150 lines)
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT — do whatever you want with it.

## Optional: Firebase Storage (cross-environment image transfer)

By default, generated images are saved to `~/nano-banana-output/` on the machine running the MCP server. If you want images to be usable in another environment (e.g. embedding in a document built by Claude's sandbox) without manually attaching files, configure Firebase Storage. The server will upload each image and return a time-limited signed URL that the other environment can download directly.

Point at your service-account JSON key file (recommended):

```json
"env": {
  "GEMINI_API_KEY": "[API_KEY]",
  "SERVICE_ACCOUNT_KEY_PATH": "/absolute/path/to/firebase-service-account.json",
  "FIREBASE_STORAGE_BUCKET": "your-project.appspot.com"
}
```

Download the JSON key from Firebase Console → Project Settings → Service Accounts → Generate new private key, save it somewhere on your machine, and point `SERVICE_ACCOUNT_KEY_PATH` at it.

Alternatively, supply the individual fields instead of a key file (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, plus `FIREBASE_STORAGE_BUCKET`).

Optional: `FIREBASE_SIGNED_URL_MINUTES` (default 60) controls how long the download URL stays valid.

Notes:
- The service-account credentials stay in the MCP server process only — they are never sent to Claude or its sandbox. The sandbox only ever sees a plain signed URL.
- Get the service-account values from Firebase Console → Project Settings → Service Accounts → Generate new private key.
- If any of the four vars is missing, uploads stay disabled and the server falls back to saving locally.
- For the download to work, the environment fetching the URL must have outbound network access to `storage.googleapis.com`.

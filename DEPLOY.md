# Deploying to Cloud Run

The server runs in Streamable HTTP mode (`node build/http.js`, see the
"Remote (HTTP) mode" section of the README) behind Supabase Auth.

## Prerequisites

- `gcloud` CLI authenticated against the `senegal-ci-maths` project.
- The Gemini API key stored in Secret Manager (never as a plain env var in
  scripts or docs):

  ```bash
  printf '%s' 'YOUR-GEMINI-KEY' | gcloud secrets create gemini-api-key \
    --project senegal-ci-maths --data-file=-
  ```

- Grant the Cloud Run runtime service account access to the secret
  (`roles/secretmanager.secretAccessor` on `gemini-api-key`).

## Deploy

```bash
gcloud run deploy nano-banana-mcp \
  --source . \
  --project senegal-ci-maths \
  --region europe-west1 \
  --max-instances 1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app,SUPABASE_URL=https://YOUR-PROJECT.supabase.co,PUBLIC_URL=https://nano-banana-mcp-XXXXXXXX-ew.a.run.app
```

Note on `--allow-unauthenticated`: this only disables the **GCP IAM** layer so
MCP clients can reach the service. Application-level auth is still enforced —
with `SUPABASE_URL` set, `/mcp` rejects requests without a valid Supabase JWT
(401), and the server refuses to start without either `SUPABASE_URL` or the
explicit `ALLOW_UNAUTHENTICATED=1` escape hatch.

`PUBLIC_URL` is the service's own public URL (used in the OAuth
protected-resource metadata). On the first deploy you may not know it yet:
deploy once, note the `*.run.app` URL Cloud Run prints, then update the env var
(`gcloud run services update nano-banana-mcp --project senegal-ci-maths --region europe-west1 --update-env-vars PUBLIC_URL=...`).

## Environment variables

| Variable | Where | Notes |
|----------|-------|-------|
| `GEMINI_API_KEY` | Secret Manager (`--set-secrets`) | Required |
| `FIREBASE_STORAGE_BUCKET` | env var | Enables signed download URLs |
| `SUPABASE_URL` | env var | Enables Supabase JWT auth on `/mcp` |
| `PUBLIC_URL` | env var | The service's public base URL |
| `PORT` | — | Set by Cloud Run automatically; the server reads it (default 8080) |

## Firebase credentials on Cloud Run (no key file)

Locally, Firebase Storage is configured with a service-account key file via
`SERVICE_ACCOUNT_KEY_PATH`. **On Cloud Run, do not upload a key file.** When
`FIREBASE_STORAGE_BUCKET` is set but no `SERVICE_ACCOUNT_KEY_PATH` /
`FIREBASE_CLIENT_EMAIL`+`FIREBASE_PRIVATE_KEY`+`FIREBASE_PROJECT_ID` vars are,
the server falls back to **Application Default Credentials** — i.e. the Cloud
Run runtime service account. `SERVICE_ACCOUNT_KEY_PATH` stays a local-only
convenience.

Two IAM notes for the runtime service account:

- It needs access to the bucket (e.g. `roles/storage.objectAdmin` on the
  bucket, which also covers the lifecycle-rule check at startup — that check is
  best-effort and only logs a warning if not permitted).
- **Signed URLs require `roles/iam.serviceAccountTokenCreator`** on itself:
  with ADC there is no private key in the container, so the Storage SDK signs
  URLs through the IAM `signBlob` API.

  ```bash
  RUNTIME_SA=$(gcloud run services describe nano-banana-mcp \
    --project senegal-ci-maths --region europe-west1 \
    --format 'value(spec.template.spec.serviceAccountName)')
  gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
    --project senegal-ci-maths \
    --member "serviceAccount:$RUNTIME_SA" \
    --role roles/iam.serviceAccountTokenCreator
  ```

## Smoke test

```bash
BASE=https://nano-banana-mcp-XXXXXXXX-ew.a.run.app
curl -s "$BASE/healthz"                       # -> ok
curl -si -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
# -> 401 with a WWW-Authenticate header (auth is on); with a valid Supabase
#    Bearer token the same request returns the initialize result and an
#    mcp-session-id response header.
```

# AI PR Reviewer

A GitHub App that automatically reviews pull requests with an AI agent. It
clones the PR, investigates the changed code, verifies findings, and publishes
a summary plus inline review comments.

The production stack is a single Docker Compose project — Probot webhook app,
review worker, PostgreSQL, Redis, one-shot migrations, and optional scheduled
backups — designed to run on [Dokploy](https://dokploy.com).

## Before you start

You need:

- A **Dokploy** host (v0.21+) with a domain you can point at it, and Docker
  Compose v2.
- A **GitHub App** (created in step 1) and its private key.
- An **OpenAI-compatible model endpoint** and API key. The default is
  Cloudflare GLM-4.7-Flash (`workers-ai/@cf/zai-org/glm-4.7-flash`).
- About **4 GB RAM minimum** for the primary stack, **8 GB recommended** with
  Phoenix and Dozzle (the configured limits total ~3.2 GiB), and **10 GB disk**.

---

## Deploy on Dokploy

### 1. Create the GitHub App

In GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Setting        | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Homepage URL   | `https://<your-domain>`                                 |
| Webhook URL    | `https://<your-domain>/` (trailing slash, no path)      |
| Webhook secret | a random secret — you will reuse it as `WEBHOOK_SECRET` |

**Repository permissions** (minimum):

| Permission    | Access           |
| ------------- | ---------------- |
| Contents      | Read             |
| Pull requests | Read and write   |
| Checks        | Read             |
| Metadata      | Read (always on) |

**Subscribe to events:** `Pull request`, `Issue comment`, `Installation`,
`Installation repositories`.

Then:

1. **Generate a private key** and save the `.pem` file.
2. Note the **App ID**.

> You can set the webhook URL now or after the domain exists; update it any
> time in the App settings. Install the App on your organization after the
> first deployment (step 6).

### 2. Create the Compose service in Dokploy

1. Create a **Project** in Dokploy.
2. Add a **Compose** service and point it at this repository and branch.
3. Set **Compose Path** to:

   ```
   deploy/docker-compose.yml
   ```

   The build context is the repository root (`build.context: ..`), so
   `Dockerfile` at the root is used automatically.

Do **not** add host-port mappings. Ingress is handled by Dokploy's Traefik over
the external `dokploy-network`; publishing a host port would collide with
Dokploy's gateway.

### 3. Fill in the environment

Open the service's **Environment** tab and paste the contents of
[`deploy/.env.prod.example`](deploy/.env.prod.example), then fill in real
values. Dokploy writes this to `.env` in the same directory as the compose file
(`deploy/.env`), which is exactly what the compose `env_file` expects.

Generate the secrets locally:

```sh
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # WEBHOOK_SECRET (must match the GitHub App)
openssl rand -hex 32   # SESSION_SECRET (admin panel only)

# GitHub App private key as one line of base64 (recommended on Dokploy)
base64 -i github-app.private-key.pem | tr -d '\n'        # macOS
# base64 -w0 github-app.private-key.pem                  # Linux
```

**Required variables:**

| Variable                    | Meaning                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`         | Database password (any strong random value).                                                                                                                           |
| `APP_ID`                    | GitHub App ID.                                                                                                                                                         |
| `WEBHOOK_SECRET`            | Webhook secret configured on the GitHub App.                                                                                                                           |
| `GITHUB_PRIVATE_KEY_BASE64` | The App private key PEM as single-line base64. Alternatives: `GITHUB_PRIVATE_KEY` (raw PEM) or `GITHUB_PRIVATE_KEY_PATH` (file inside the container). Use exactly one. |
| `MODEL_API_KEY`             | API key for the model endpoint.                                                                                                                                        |
| `MODEL_NAME`                | Model identifier in `provider/model` form (default: `workers-ai/@cf/zai-org/glm-4.7-flash`).                                                                           |
| `MODEL_BASE_URL`            | OpenAI-compatible base URL (default: `https://llm.nativewit.app/compat`).                                                                                              |

**Optional but recommended:**

| Variable                                                                 | Meaning                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                                                         | Required for the admin panel; also set the `ADMIN_*` OAuth variables below.                                                                                     |
| `DOKPLOY_NETWORK`                                                        | Ingress network name. Default `dokploy-network` matches Dokploy; change only if your host uses another name (`docker network ls \| grep dokploy`).              |
| `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS`, `BACKUP_MAX_AGE_HOURS` | Backup cadence, retention, and staleness alarm (defaults `24`, `14`, `26`).                                                                                     |
| `PHOENIX_ENDPOINT`                                                       | Optional Phoenix OTLP/HTTP endpoint (default `http://phoenix:6006`). See [docs/deployment.md](docs/deployment.md#agent-tracing-optional--phoenixopentelemetry). |
| `OPENCODE_OTLP_HEADERS`                                                  | Only when Phoenix auth is enabled: `authorization=Bearer <phoenix-system-api-key>` for trace ingestion.                                                         |

`PROBOT_PORT` is only used by the local smoke-run override; leave it as-is on
Dokploy.

### 4. Add a domain

In the Compose service, open **Domains** and add:

- **Host**: `reviewer.yourdomain.com` (or a DNS-free
  `<prefix>.<public-ip-with-dashes>.sslip.io`)
- **Service**: `probot`
- **Container Port**: `3000`
- **HTTPS**: enabled (Let's Encrypt)

Dokploy's Traefik injects the routing labels at deploy time — do not add
Traefik labels manually.

### 5. Deploy and verify

Click **Deploy**. The deploy sequence is:

1. Build the app image and the backup image.
2. `postgres` and `redis` become healthy.
3. `migrate` runs `prisma migrate deploy` once and exits `0`.
4. `probot` and `worker` start and become healthy.
5. If the `backup` profile is enabled, `backup` takes the first dump on start.
   It is off by default in the lean deployment (see
   [Backups and upgrades](#backups-and-upgrades)).

Verify from anywhere:

```sh
curl -fsS https://<your-domain>/healthz   # {"status":"ok"}
curl -fsS https://<your-domain>/readyz   # Postgres + Redis status
```

In Dokploy's deployment logs, confirm `migrate` is **Exited (0)** and
`probot`/`worker`/`postgres`/`redis` are healthy. If `probot` is healthy but
logs `APP_ID / PRIVATE_KEY not configured`, the App credentials are missing
from the environment.

### 6. Install the App and open a PR

1. In the GitHub App settings, click **Install App** and install it on your
   organization, selecting the repositories to review.
2. Make sure the App's **Webhook URL** is `https://<your-domain>/` and the
   webhook secret matches `WEBHOOK_SECRET`.
3. Open a pull request (or push a new commit to one). A review job is queued and
   results appear as a PR summary plus inline comments.
4. Comment `/review` on a PR to trigger a manual review. Draft PRs are skipped
   by default. The command accepts a review type:
   `/review` (default `standard`), `/review type:skill` (playbook-injected
   methodology) and `/review type:handbook` (standards pulled from the
   configured handbook repo). All types review the same commit independently;
   by default only `standard` posts findings back to GitHub
   (`review.types.<type>.publish`), the others persist results for
   comparison (`GET /api/admin/reviews/compare`).

### Knowledge sources (skill playbook / handbook)

The skill playbook and the engineering handbook are fetched ONCE per worker boot
into a persistent cache (`KNOWLEDGE_CACHE_DIR`, default `<workspaces-root>/knowledge`)
— never per review. Refs should be pinned commit SHAs in prod via
`KNOWLEDGE_SKILL_REF` / `KNOWLEDGE_HANDBOOK_REF` (they override
`knowledge.skill.ref` / `knowledge.handbook.ref` in `config/review.json`; a branch
name is resolved to its current commit SHA at boot). Optional bearer token:
`KNOWLEDGE_GITHUB_TOKEN` (or `GITHUB_TOKEN`) for private handbook repos. If a fetch
fails the worker still starts, but there is no fallback content: the source is marked
unavailable and skill/handbook reviews fail fast (`SKILL_PLAYBOOK_UNAVAILABLE` /
`HANDBOOK_UNAVAILABLE`). Each review persists the
exact knowledge snapshot it started with (`Review.knowledgeSnapshot`) and injects
from its own workspace copy, so cache refreshes never alter an in-flight review; the
comparison endpoint reports the per-source ref + content hash plus the additive
`knowledgeMetrics` (estimated injected tokens, retrieval funnel, truncation flag).
Handbook content can also come from a per-technology ref via
`knowledge.handbook.technologyRefs` (e.g. TypeScript guidelines living on a
separate branch): every configured ref is fetched at boot, and a review whose
changed files are detected as one of the listed technologies (`.ts` →
`typescript`/`nodejs`) injects that ref instead of the default `handbook.ref`.
`KNOWLEDGE_HANDBOOK_REF` overrides only the default ref; pin each
`technologyRefs[].ref` to a SHA in prod as well.

Injection budgets are token-based (`knowledge.skill.maxTokens` default 1500,
`knowledge.handbook.maxTokens` default 3000, ≈4 chars/token; `maxChars` is a
byte-level backstop). The handbook instruction profile lives in
`src/review-engine/prompts/handbook-review.ts`; retrieval (technology detection,
ranking, dedup, deterministic selection) is application-side — the agent never
retrieves knowledge itself.

Review behavior (categories, confidence thresholds, execution policy, model,
etc.) lives in [`config/review.json`](config/review.json). It is baked into the
image, so config-file changes require a rebuild/redeploy — or change it at
runtime from the admin panel.

---

## Optional: admin panel

The app serves a server-rendered admin panel at `https://<your-domain>/admin`.

1. Create a **separate GitHub OAuth App** (not the GitHub App from step 1):
   - Homepage: `https://<your-domain>`
   - Callback URL: `https://<your-domain>/api/admin/auth/github/callback`
2. Set these environment variables and redeploy:
   - `ADMIN_OAUTH_CLIENT_ID`
   - `ADMIN_OAUTH_CLIENT_SECRET`
   - `ADMIN_OAUTH_CALLBACK_URL`
   - `SESSION_SECRET`
   - `ADMIN_GITHUB_ORG` — organization allowed to sign in
   - `ADMIN_GITHUB_LOGINS` — optional comma-separated admin logins
3. Sign in at `/admin`. Without these variables the admin routes return `503`.

The panel can validate, save, reload, and roll back configuration, with every
change written to the audit log. Secrets are never displayed.

---

## Optional: live logs with Dozzle

[Dozzle](https://dozzle.dev) provides a web UI over `docker logs`. Deploy it as
a **second Compose service in the same Dokploy project**, pointing at
`deploy/docker-compose.dozzle.yml`:

- Environment: `DOZZLE_ADMIN_PASSWORD` (required)
- Add a domain entry on your **existing Probot hostname**:
  Path `/dozzle`, **Strip Path OFF**, Container Port `8080`
- Open `https://<your-probot-domain>/dozzle/` and sign in as `admin` with that
  password. The admin panel also links to it as **Container logs**.

It must run on the same Docker host as this stack. Note that mounting the
Docker socket is root-equivalent on the host — restrict the path to admin
IPs/VPN where possible. Full details and CGNAT/tunnel guidance are in
[docs/deployment.md](docs/deployment.md#10-dozzle--live-container-log-viewer-operations-stack).

---

## Backups and upgrades

- Automated backups are **disabled by default** in the lean deployment
  (`backup` Compose profile). PostgreSQL data still lives in the
  `postgres-data` named volume and survives container recreation.
- Enable the schedule with
  `docker compose -f deploy/docker-compose.yml --profile backup up -d backup`;
  dumps go to the `pg-backups` volume (`BACKUP_INTERVAL_HOURS`, retention
  configurable). A healthcheck fails when the newest dump is stale.
- Take a manual dump before production even while the schedule is off — the
  command is in [docs/deployment.md §7.1](docs/deployment.md#71-how-it-works).
- **A Docker volume is not an off-host backup.** Replicate `pg-backups` to
  S3/another host, or use Dokploy's volume backup feature.
- To upgrade, redeploy the service (Dokploy can auto-deploy on push). Migrations
  are applied automatically by the one-shot `migrate` service and are
  append-only.
- Restore procedures (online and offline) are documented in
  [docs/deployment.md §7](docs/deployment.md#7-backup-and-restore--tested).

---

## Local development

Requires **Node.js 24 or newer** (`engines.node` is `>=24`; the OpenCode SDK
runtime needs Node >= 24, and the production image pins `node:24.22.3`).

```sh
npm install
npm run build
npm run start:probot   # Probot + admin API + health on http://localhost:3000
npm run start:worker   # review worker (separate terminal; needs Redis)
```

For the full stack locally:

```sh
cp deploy/.env.prod.example deploy/.env   # fill in real values
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  up -d
```

Create the ingress network once if it does not exist:
`docker network create dokploy-network`.

Useful commands:

```sh
npm test                 # all test tiers (unit, contract, integration, characterization)
npm run config:validate  # validate config/review.json
npm run model:smoke      # check model endpoint connectivity
```

---

## Troubleshooting

| Symptom                                                    | Likely cause / fix                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docker compose config` fails with `set POSTGRES_PASSWORD` | A required variable is missing from the Dokploy environment.                                       |
| `probot` healthy but no reviews                            | `APP_ID` / private key missing or unreadable; App not installed on the repo.                       |
| GitHub webhook deliveries show 404                         | Webhook URL must be `https://<your-domain>/` (root, trailing slash).                               |
| Domain returns 502                                         | Domain must target service `probot`, container port `3000`; `probot` must be on `dokploy-network`. |
| Admin routes return 503                                    | `ADMIN_OAUTH_*` + `SESSION_SECRET` are not set.                                                    |
| `migrate` fails                                            | Usually a wrong `POSTGRES_PASSWORD` or Postgres not yet healthy — check its logs.                  |
| `worker` unhealthy                                         | Check worker logs; it exposes `/metrics` on port `9100` inside the container.                      |
| Private key parse error                                    | Use single-line base64 (`GITHUB_PRIVATE_KEY_BASE64`) or a correctly quoted raw PEM.                |

---

## Documentation

- **[docs/how-pr-review-works.md](docs/how-pr-review-works.md)** — teaching
  guide: what happens to a PR under the hood, the exact prompts, the output
  contract, and the failure modes.
- **[docs/architecture.md](docs/architecture.md)** — system design, review
  lifecycle, security model, configuration reference.
- **[docs/deployment.md](docs/deployment.md)** — full operations guide:
  topology, secrets, backup/restore evidence, restart recovery, Dokploy and
  Dozzle setup, validation runbook.
- **[docs/agent-runtime-plugins.md](docs/agent-runtime-plugins.md)** — runtime
  plugin API, CLI vs SDK selection, security boundary and operations.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 Surya <surya@example.com>

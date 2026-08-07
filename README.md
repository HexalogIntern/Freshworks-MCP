# Freshsales MCP Server

Read-only MCP server for live Freshsales CRM access from Claude. Every tool uses a two-step `propose -> approve` flow; the first call returns a pending approval payload and the second call with `approved: true` and the returned `request_id` executes the Freshsales request.

## Tools

- `list_leads(filter, page, per_page)`
- `get_lead(id)`
- `list_deals(stage, owner, date_from, date_to, page, per_page)`
- `get_deal(id)`
- `search_contacts(query, page, per_page)`
- `list_notes(entity_type, entity_id)`
- `pipeline_summary(group_by)`
- `usage_status()`

## Environment

Copy `.env.example` to `.env` locally and set:

- `FRESHSALES_API_KEY`: Freshsales API key, server-side only.
- `FRESHSALES_DOMAIN`: Freshsales domain, for example `https://example.myfreshworks.com`.
- `FRESHSALES_DEFAULT_LEADS_VIEW_ID`: Freshsales leads view id used by `list_leads`.
- `FRESHSALES_DEFAULT_DEALS_VIEW_ID`: Freshsales deals view id used by `list_deals` and `pipeline_summary`.
- `MCP_SERVER_TOKEN`: Optional bearer token required by `/mcp` when set.
- `DAILY_CALL_LIMIT`: Hard Freshsales API call cap per reset window, default `200`.
- `APPROVAL_TTL_SECONDS`: Approval request lifetime, default `300`.
- `RESET_TIMEZONE`: Midnight reset timezone, default `UTC`.
- `MCP_ALLOWED_ORIGINS`: Comma-separated allowed browser origins, for example `https://claude.ai`.
- `MCP_ALLOWED_HOSTS`: Comma-separated allowed hostnames for DNS rebinding protection.
- `FRESHSALES_MAX_429_RETRIES`: 429 retry count, default `1`.
- `FRESHSALES_MAX_RETRY_WAIT_MS`: Max retry wait, default `2000`.
- `LOCAL_RATE_LIMIT_PER_MINUTE`: Local per-minute safety cap, default `60`.
- `PIPELINE_SUMMARY_MAX_PAGES`: Max deal pages scanned by `pipeline_summary`, default `5`.

## Local Run

```bash
npm ci
npm run build
npm test
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

MCP endpoint:

```text
http://localhost:3000/mcp
```

## Deploy to Render (recommended, free)

1. Push this repo to GitHub.
2. In Render, create a new Blueprint from the repo. Render will read `render.yaml`.
3. Set the secret env vars marked `sync: false` in `render.yaml`.
4. Set `MCP_ALLOWED_HOSTS` to your Render hostname, for example `freshsales-mcp-server.onrender.com`.
5. Deploy and verify `https://your-service.onrender.com/health`.

Render Free web services can spin down after idle periods. The server still works correctly without a keep-alive, but the first Claude tool call after idle may wait through a cold start.

### Optional Keep-Alive

Use cron-job.org as the zero-cost keep-alive. Render Cron Jobs have a minimum monthly charge, while cron-job.org documents that its service is entirely free and supports schedules as frequent as once per minute. This keep-alive only calls `/health`, which does not require auth, does not call Freshsales, and does not touch `DAILY_CALL_LIMIT`.

1. Create a free account at `https://cron-job.org`.
2. Create a new cronjob.
3. Set URL to `https://your-service.onrender.com/health`.
4. Set method to `GET`.
5. Set schedule to every 10 minutes, or cron expression `*/10 * * * *`.
6. Leave authentication headers empty.
7. Save, then run a manual test from cron-job.org and confirm HTTP `200`.

## Alternative: Deploy to Railway (paid, optional)

Railway's free trial credit is one-time; ongoing use requires the Hobby plan, roughly `$5/month` minimum plus usage-based costs. Unlike Render's free tier, this is a real recurring cost. Only choose Railway if you are OK with that tradeoff.

1. Create a Railway project from this repository.
2. Use `npm ci && npm run build` as the build command.
3. Use `npm start` as the start command.
4. Add the same environment variables listed in the Environment section.
5. Let Railway provide `PORT`; the server reads it from the environment.
6. After deploy, verify `https://your-railway-domain/health`.

## Claude Connector

Register the deployed endpoint as a custom MCP connector in Claude:

- URL: `https://your-service.onrender.com/mcp`
- Transport: Streamable HTTP
- Authorization header: `Bearer <MCP_SERVER_TOKEN>` if `MCP_SERVER_TOKEN` is set

For every tool, first call without `approved: true`, review the returned `request_id` and preview, then call the same tool with `approved: true` and `request_id`.

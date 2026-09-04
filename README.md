# Freshsales MCP Server

Read-only MCP server for live Freshsales CRM access from Claude. Every tool uses a two-step `propose -> approve` flow; the first call returns a pending approval payload and the second call with `approved: true` and the returned `request_id` executes the Freshsales request.

## Tools

- `discover_views(entity, sample_pages_per_view)`
- `list_contacts(view, source, filter_by, filter_value, match_mode, owner, date_from, date_to, page, per_page)`
- `query_records(entity, filters, filter_groups, query, include_notes, include_linked, fields, page, per_page)`
- `generate_custom_report(entity, description, metrics, group_by, filters, date_from, date_to, limit, max_group_values)`
- `run_report(entity, filters, group_by, metrics, sort_by, limit, max_group_values)`
- `get_analytics_report(report_name, report_id, export_id, timeout_ms, poll_interval_ms, max_rows)`
- `export_records(entity, filters, fields, cursor, per_page, detect_duplicates)`
- `get_contact(id)`
- `list_deals(stage, view, filter_by, filter_value, match_mode, owner, date_from, date_to, page, per_page)`
- `get_deal(id)`
- `search_contacts(query, page, per_page)`
- `list_notes(entity_type, entity_id)`
- `pipeline_summary(group_by)`
- `usage_status()`

### Behavior Changes

`run_report` now uses Freshsales `filtered_search` totals for count-only reports grouped by one or two dropdown fields. This returns exact counts with one Freshsales count request per grouped dropdown value and sets `total_kind: "native_aggregation"` with `aggregation_strategy: "filtered_search_count_per_group_value"`. Reports with non-count metrics, date buckets, or non-dropdown groupings keep the paginated fallback and return `aggregation_strategy: "paginated_client_aggregation"`.

`generate_custom_report` accepts natural-language report requests plus optional structured overrides. For example, `"Since 1st July 12 am, how many contacts have been created grouped by Source and status"` is translated into a `created_at` date filter, `Source`/`Status` groupings, and a count metric. It returns the interpreted `run_report` request with the generated data; it does not create saved reports inside the Freshsales UI.

Field resolution now includes common Freshsales aliases such as `source`, `status`, `created`, `stage`, `pipeline`, `owner`, and `deal value`, and can infer custom API names like `cf_source` from the user-facing label. Contact `Status` values are hydrated from Freshsales contact status selector metadata when the field schema does not include choices directly.

API calls are compacted for common query shapes: contact status metadata tries the selector endpoint first, `list_contacts` uses native Freshsales filters for `source`/`filter_by` plus `date_from`/`date_to`, `list_deals` uses native filters for field/date combinations without owner/stage matching, and `run_report` only enumerates explicitly filtered group values when possible.

`discover_fields` now returns only `api_field` and `ui_label` by default. Pass `include_choices: ["Field label or api_field"]` to include dropdown choices for specific fields.

Every approved tool result now includes `_meta.freshsales_call_count` and `_meta.freshsales_calls`; `usage_status` also includes per-tool totals and recent call/invocation breakdowns.

### View Discovery and Filter Performance

`discover_views` proactively scans saved Freshsales contact and deal views, samples up to `sample_pages_per_view` pages per view, and caches which fields and sample values appear in each view. Run it once after deploy, and again after adding new custom Freshsales views or when you suspect the cache is stale.

This keeps later filtered `list_contacts` and `list_deals` calls cheaper: when the cache knows a view contains a matching `source` or `filter_by` value, the list tool can scan that likely view first instead of immediately falling back to a broad multi-view scan. The tool is still read-only, still uses the normal propose-then-approve flow, and its real Freshsales calls count against `DAILY_CALL_LIMIT`.

## Environment

Copy `.env.example` to `.env` locally and set:

- `FRESHSALES_API_KEY`: Freshsales API key, server-side only.
- `FRESHSALES_DOMAIN`: Freshsales domain, for example `https://example.myfreshworks.com`.
- `FRESHSALES_DEFAULT_CONTACTS_VIEW_ID`: Freshsales contacts view id used by `list_contacts`.
- `FRESHSALES_DEFAULT_DEALS_VIEW_ID`: Freshsales deals view id used by `list_deals` and `pipeline_summary`.
- `OAUTH_CLIENT_ID`: Static OAuth client id for Claude custom connector setup.
- `OAUTH_CLIENT_SECRET`: Static OAuth client secret for Claude custom connector setup.
- `DAILY_CALL_LIMIT`: Hard Freshsales API call cap per reset window, default `200`.
- `APPROVAL_TTL_SECONDS`: Approval request lifetime, default `300`.
- `RESET_TIMEZONE`: Midnight reset timezone, default `UTC`.
- `MCP_ALLOWED_ORIGINS`: Comma-separated allowed browser origins, for example `https://claude.ai`.
- `MCP_ALLOWED_HOSTS`: Comma-separated allowed hostnames for DNS rebinding protection.
- `FRESHSALES_MAX_429_RETRIES`: 429 retry count, default `1`.
- `FRESHSALES_MAX_RETRY_WAIT_MS`: Max retry wait, default `2000`.
- `LOCAL_RATE_LIMIT_PER_MINUTE`: Local rolling per-minute safety cap, default `600`.
- `PIPELINE_SUMMARY_MAX_PAGES`: Max deal pages scanned by `pipeline_summary`, default `5`.
- `CONTACTS_SCAN_MAX_PAGES`: Max pages scanned per contacts view for filtered contact queries, default `10`.
- `CONTACTS_SCAN_MAX_VIEWS`: Max contact views scanned during a broad filtered contact search, default `15`.
- `DEALS_SCAN_MAX_PAGES`: Max pages scanned per deals view for filtered deal queries, default `10`.
- `DEALS_SCAN_MAX_VIEWS`: Max deal views scanned during a broad filtered deal search, default `15`.
- `FIELD_SCHEMA_CACHE_TTL_MS`: Freshsales field metadata cache TTL in milliseconds, persisted under the system temp directory, default `86400000`.
- `ANALYTICS_REPORT_CACHE_TTL_MS`: Freshsales Analytics saved report cache TTL in milliseconds, persisted under the system temp directory, default `86400000`.
- `FRESHSALES_ANALYTICS_REPORTS_PATH`: Analytics report-list endpoint path, default `api/reports`.
- `FRESHSALES_ANALYTICS_REPORT_EXPORT_PATH_TEMPLATE`: One-time Analytics export trigger path. Use `{report_id}` as the placeholder, default `api/reports/{report_id}/export`.
- `FRESHSALES_ANALYTICS_EXPORT_STATUS_PATH_TEMPLATE`: Analytics export status path. Use `{export_id}` as the placeholder, default `api/reports/exports/{export_id}`.
- `VIEW_LIST_CACHE_TTL_MS`: In-memory saved-view list cache TTL in milliseconds, default `3600000`.
- `VIEW_FIELD_COVERAGE_CACHE_TTL_MS`: In-memory view field/value coverage cache TTL in milliseconds, default `3600000`.
- `FRESHSALES_REQUEST_TIMEOUT_MS`: Freshsales upstream request timeout in milliseconds, default `10000`.
- `MCP_REQUEST_TIMEOUT_MS`: MCP HTTP request timeout in milliseconds, default `25000`.

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
5. Set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` to random static values that you will also enter in Claude.
6. Deploy and verify `https://your-service.onrender.com/health`.

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
- Advanced settings OAuth Client ID: the exact `OAUTH_CLIENT_ID` value from Render.
- Advanced settings OAuth Client Secret: the exact `OAUTH_CLIENT_SECRET` value from Render.

When you click Connect, Claude discovers the server's OAuth metadata at `/.well-known/oauth-authorization-server`, redirects through `/authorize`, exchanges the code at `/token`, then calls `/mcp` with its issued OAuth token. You do not need to enter a manual `Authorization: Bearer ...` header in Claude. This OAuth shim is intentionally single-owner and in-memory; if the server restarts, reconnect the Claude connector.

For non-Claude MCP clients only, `MCP_SERVER_TOKEN` remains supported as an optional direct bearer credential if you choose to set it.

For every tool, first call without `approved: true`, review the returned `request_id` and preview, then call the same tool with `approved: true` and `request_id`.

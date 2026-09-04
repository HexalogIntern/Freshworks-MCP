# Changelog

## Unreleased

- Added `get_analytics_report`, which resolves saved Freshsales Analytics reports by cached fuzzy name lookup or `report_id`, triggers/resumes export jobs, polls briefly, downloads CSV output when ready, and returns parsed JSON rows. Pending exports return `status: "pending"` with `export_id`.
- `run_report` now uses native Freshsales `filtered_search` counts for count-only dropdown grouping and reports `aggregation_strategy`; unsupported report shapes still use the paginated fallback.
- `discover_fields` now returns only `api_field` and `ui_label` unless specific fields are requested through `include_choices`.
- `usage_status` now includes per-tool call totals, recent Freshsales calls, recent tool invocations, and rolling-minute limiter state. The default local minute cap is now `600`, and field/report metadata cache TTL defaults to 24 hours.
- Freshsales contact and deal filters now discover saved views through `api/contacts/filters` and `api/deals/filters`. When a filtered request does not specify `view`, the tools scan saved views sequentially, deduplicate records by `id`, and add `matched_views` to records found in one or more views.
- Contact `source` was confirmed to be missing or view-scoped for records where the Freshsales UI still shows values such as `paid_meta`; this was not a simple local filter bug. `contacts_summary` now scans contact views for `group_by=source` and can bucket view-scoped paid media contacts as `paid_meta` instead of folding them into `Unknown`.
- Filtered responses include `views_scanned`, `views_skipped_due_to_cap`, and `truncated` so Claude can explain scan coverage and partial results accurately. The new caps are `CONTACTS_SCAN_MAX_VIEWS` and `DEALS_SCAN_MAX_VIEWS`, both defaulting to `15`.

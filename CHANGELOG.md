# Changelog

## Unreleased

- Freshsales contact and deal filters now discover saved views through `api/contacts/filters` and `api/deals/filters`. When a filtered request does not specify `view`, the tools scan saved views sequentially, deduplicate records by `id`, and add `matched_views` to records found in one or more views.
- Contact `source` was confirmed to be missing or view-scoped for records where the Freshsales UI still shows values such as `paid_meta`; this was not a simple local filter bug. `contacts_summary` now scans contact views for `group_by=source` and can bucket view-scoped paid media contacts as `paid_meta` instead of folding them into `Unknown`.
- Filtered responses include `views_scanned`, `views_skipped_due_to_cap`, and `truncated` so Claude can explain scan coverage and partial results accurately. The new caps are `CONTACTS_SCAN_MAX_VIEWS` and `DEALS_SCAN_MAX_VIEWS`, both defaulting to `15`.

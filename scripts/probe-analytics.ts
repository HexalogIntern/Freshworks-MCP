import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

const reportId = process.argv[2] ?? "235006";
const encodedReportId = Buffer.from(reportId, "utf8").toString("base64");
const apiKey = requiredEnv("FRESHSALES_API_KEY");
const domain = normalizeDomain(requiredEnv("FRESHSALES_DOMAIN"));
const origin = new URL(domain).origin;

const candidates = unique([
  `${origin}/crm/sales/api/analytics/reports/${reportId}`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/data`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/page/1`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/pages/1`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/widgets`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/chart_data`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/table_data`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/query`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}/export`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}?include=data`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}?include=widgets`,
  `${origin}/crm/sales/api/analytics/reports/${reportId}?page=1`,
  `${origin}/crm/sales/api/analytics/report/${reportId}`,
  `${origin}/crm/sales/api/analytics/report/${reportId}/data`,
  `${origin}/crm/sales/api/analytics/report_data?report_id=${reportId}`,
  `${origin}/crm/sales/api/analytics/report_data/${reportId}`,
  `${origin}/crm/sales/api/analytics/report_definitions/${reportId}`,
  `${origin}/crm/sales/api/analytics/report_definitions/${reportId}/data`,
  `${origin}/crm/sales/api/analytics/report-definitions/${reportId}`,
  `${origin}/crm/sales/api/analytics/dashboard_reports/${reportId}`,
  `${origin}/crm/sales/api/reports/${reportId}`,
  `${origin}/crm/sales/api/reports/${reportId}/data`,
  `${origin}/crm/sales/api/reports/${reportId}/page/1`,
  `${origin}/crm/sales/api/reports/${reportId}/chart_data`,
  `${origin}/crm/sales/api/reports/${reportId}/table_data`,
  `${origin}/crm/sales/api/reports/${reportId}/query`,
  `${origin}/crm/sales/api/reports/${reportId}/export`,
  `${origin}/crm/sales/api/report/${reportId}`,
  `${origin}/crm/sales/api/report/${reportId}/data`,
  `${origin}/crm/sales/api/report_data?report_id=${reportId}`,
  `${origin}/crm/sales/api/report_definitions/${reportId}`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}/data`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}/page/1`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}/chart_data`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}/table_data`,
  `${origin}/crm/sales/api/analytic_reports/${reportId}/query`,
  `${origin}/crm/sales/api/analytics_reports/${reportId}`,
  `${origin}/crm/sales/api/analytics_reports/${reportId}/data`,
  `${origin}/crm/sales/api/sales_reports/${reportId}`,
  `${origin}/crm/sales/api/sales_reports/${reportId}/data`,
  `${origin}/crm/sales/api/dashboards/reports/${reportId}`,
  `${origin}/crm/sales/api/dashboards/reports/${reportId}/data`,
  `${origin}/crm/sales/api/analytics/reports/${encodedReportId}`,
  `${origin}/crm/sales/api/analytics/reports/${encodedReportId}/data`,
  `${origin}/crm/sales/api/reports/${encodedReportId}`,
  `${origin}/crm/sales/api/reports/${encodedReportId}/data`,
  `${origin}/api/analytics/reports/${reportId}`,
  `${origin}/api/analytics/reports/${reportId}/data`,
  `${origin}/api/reports/${reportId}`,
  `${origin}/api/reports/${reportId}/data`,
  `${origin}/api/analytic_reports/${reportId}`,
  `${origin}/api/analytic_reports/${reportId}/data`,
  `${origin}/analytics/api/reports/${reportId}`,
  `${origin}/analytics/api/reports/${reportId}/data`,
  `${origin}/analytics/api/v1/reports/${reportId}`,
  `${origin}/analytics/api/v1/reports/${reportId}/data`,
  `${origin}/crm/sales/analytics/reports/${encodedReportId}/page/1`
]);

console.log(`Freshsales Analytics GET probe for report_id=${reportId}`);
console.log(`Domain origin: ${origin}`);
console.log("Auth: Freshsales API key header, Authorization: Token token=[REDACTED]");
console.log("");

for (const url of candidates) {
  await probe(url);
}

async function probe(url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token token=${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const snippet = oneLine(body).slice(0, 200);
    const note = classify(response.status, contentType, snippet);

    console.log(JSON.stringify({
      url,
      status: response.status,
      content_type: contentType || null,
      note,
      body_first_200: snippet
    }));
  } catch (error) {
    console.log(JSON.stringify({
      url,
      status: null,
      content_type: null,
      note: "request_failed",
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

function classify(status: number, contentType: string, snippet: string): string {
  const lowerType = contentType.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();
  if (status === 401 || status === 403) {
    return "auth_rejected_or_session_cookie_required";
  }

  if (lowerType.includes("text/html") || lowerSnippet.includes("<!doctype html") || lowerSnippet.includes("<html")) {
    return "html_shell_or_login_page";
  }

  if (lowerType.includes("application/json")) {
    return "json_response";
  }

  if (status === 404) {
    return "not_found";
  }

  return "non_json_response";
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

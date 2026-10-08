// Fetch a sheet tab by NAME via the public gviz endpoint (no OAuth, no API key)
// and convert the gviz table into RFC4180 CSV text so the existing parser
// can be reused without any change.

import { gvizUrl } from "./discovery.js";

function fetchWithTimeout(fetchFn, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function unwrapGviz(text) {
  const m = String(text || "").match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
  if (!m) throw new Error("Phản hồi gviz không hợp lệ.");
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new Error("Phản hồi gviz không parse được.");
  }
  if (!data || data.status !== "ok" || !data.table) {
    const reason =
      (data && data.errors && data.errors[0] && data.errors[0].detailed_message) ||
      (data && data.status) ||
      "unknown";
    throw new Error("Worksheet không tồn tại hoặc không đọc được (" + reason + ").");
  }
  return data.table;
}

function cellText(cell) {
  if (cell === null || cell === undefined) return "";
  const v = cell.f !== undefined && cell.f !== null ? cell.f : cell.v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function csvEscape(field) {
  const s = String(field);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** gviz table -> CSV text (header row from column labels, then data rows). */
export function gvizTableToCsv(table) {
  const cols = (table && table.cols) || [];
  const rows = (table && table.rows) || [];
  const width = Math.max(cols.length, ...rows.map((r) => ((r && r.c) || []).length), 0);
  const lines = [];
  lines.push(
    Array.from({ length: width }, (_, i) => csvEscape(cols[i] && cols[i].label ? cols[i].label : "")).join(",")
  );
  for (const r of rows) {
    const cells = (r && r.c) || [];
    lines.push(
      Array.from({ length: width }, (_, i) => csvEscape(cellText(cells[i]))).join(",")
    );
  }
  return lines.join("\n");
}

export async function fetchSheetCsvByName(
  spreadsheetId,
  sheetName,
  { fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}
) {
  if (!sheetName) throw new Error("sheetName is required");
  const url = gvizUrl(spreadsheetId, "sheet=" + encodeURIComponent(sheetName));
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  if (!res.ok) {
    const err = new Error(`gviz HTTP ${res.status} (sheet=${sheetName})`);
    err.status = res.status;
    throw err;
  }
  return gvizTableToCsv(unwrapGviz(await res.text()));
}

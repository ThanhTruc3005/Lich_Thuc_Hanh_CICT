// Worksheet discovery for a PUBLIC Google Spreadsheet (no OAuth, no API key).
// Primary: parse the public /edit HTML which embeds every tab's name + gid.
// Fallback: probe conventional week names (T00..TNN) via the public gviz endpoint.

// Bootstrap pairs appear single-escaped (\"T01\") or double-escaped (\\\"T01\\")
// depending on which page variant Google serves. \\+" matches either.
const PAIR_RE = new RegExp("\\[(\\d+),0,\\x5c+\"(\\d+)\\x5c+\",\\[\\{\\x5c+\"1\\x5c+\":\\[\\[0,0,\\x5c+\"((?:[^\"\\x5c]|\\x5cu[0-9a-fA-F]{4})*)\\x5c+\"", "g");
const CAPTION_RE = new RegExp("docs-sheet-tab-caption" + String.fromCharCode(34) + ">([^<]+)</div>", "g");


export function sheetHtmlUrl(spreadsheetId) {
  if (!spreadsheetId) throw new Error("spreadsheetId is required");
  return "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(spreadsheetId) + "/edit";
}

export function gvizUrl(spreadsheetId, params = "") {
  if (!spreadsheetId) throw new Error("spreadsheetId is required");
  return (
    "https://docs.google.com/spreadsheets/d/" +
    encodeURIComponent(spreadsheetId) +
    "/gviz/tq?tqx=out:json" +
    (params ? "&" + params : "")
  );
}

function decodeJsString(s) {
  // Names may be escape-nested (\\u00e9 inside \\\" ... \\\"); unwrap up to twice.
  let cur = s;
  for (let i = 0; i < 2; i++) {
    try {
      const next = JSON.parse('"' + cur + '"');
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur;
}

/**
 * Extract [{name, gid|null}] from the public /edit HTML.
 * Bootstrap pairs carry name+gid; tab captions fill names without gid.
 */
export function extractSheetsFromHtml(html) {
  const text = String(html || "");
  const gidByName = new Map();
  const pairOrder = [];
  for (const m of text.matchAll(PAIR_RE)) {
    const name = decodeJsString(m[3]);
    if (!gidByName.has(name)) {
      gidByName.set(name, m[2]);
      pairOrder.push(name);
    }
  }
  const captions = [];
  for (const m of text.matchAll(CAPTION_RE)) {
    const name = m[1].trim();
    if (name && !captions.includes(name)) captions.push(name);
  }
  const out = [];
  const seen = new Set();
  for (const name of captions) {
    out.push({ name, gid: gidByName.get(name) || null });
    seen.add(name);
  }
  for (const name of pairOrder) {
    if (!seen.has(name)) {
      out.push({ name, gid: gidByName.get(name) || null });
      seen.add(name);
    }
  }
  return out;
}

function fetchWithTimeout(fetchFn, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function fetchSheetHtml(spreadsheetId, { fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchWithTimeout(fetchFn, sheetHtmlUrl(spreadsheetId), timeoutMs);
  if (!res.ok) {
    const err = new Error(`Sheet HTML HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return await res.text();
}

/** Check one conventional week name via gviz (minimal range). True when the sheet exists. */
export async function probeSheetByName(
  spreadsheetId,
  name,
  { fetchFn = globalThis.fetch, timeoutMs = 10000 } = {}
) {
  const url = gvizUrl(spreadsheetId, "sheet=" + encodeURIComponent(name) + "&range=A1");
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  if (!res.ok) return false;
  const text = await res.text();
  const m = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
  if (!m) return false;
  try {
    const data = JSON.parse(m[1]);
    return data && data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Fallback discovery: probe T00..T{maxWeek}. Stops after `trailingMisses`
 * consecutive misses once at least one sheet was found. Bounded and polite.
 */
export async function probeWeekSheets(
  spreadsheetId,
  { fetchFn = globalThis.fetch, timeoutMs = 10000, maxWeek = 60, trailingMisses = 6, weekName = weekTabName } = {}
) {
  const found = [];
  let misses = 0;
  for (let n = 0; n <= maxWeek; n++) {
    const name = weekName(n);
    let hit = false;
    try {
      hit = await probeSheetByName(spreadsheetId, name, { fetchFn, timeoutMs });
    } catch {
      hit = false;
    }
    if (hit) {
      found.push({ name, gid: null });
      misses = 0;
    } else {
      misses++;
      if (found.length > 0 && misses >= trailingMisses) break;
    }
  }
  return found;
}

export function weekTabName(n) {
  return "T" + String(n).padStart(2, "0");
}

/** Keep only week-like tabs: T00, T01, ... (case-insensitive). Others are ignored. */
export function filterWeekSheets(sheets) {
  return (sheets || []).filter((s) => /^T\d{1,3}$/i.test((s && s.name) || ""));
}

/**
 * Full discovery: HTML first, gviz probing as fallback.
 * @returns {Promise<{sheets: Array<{name, gid|null}>, method: "html"|"probe"}>}
 */
export async function discoverSheets(spreadsheetId, opts = {}) {
  const { fetchFn = globalThis.fetch, timeoutMs = 15000 } = opts;
  try {
    const html = await fetchSheetHtml(spreadsheetId, { fetchFn, timeoutMs });
    const sheets = extractSheetsFromHtml(html);
    if (sheets.length > 0) return { sheets, method: "html" };
    throw new Error("No worksheets found in sheet HTML.");
  } catch (htmlErr) {
    const probed = await probeWeekSheets(spreadsheetId, { fetchFn, timeoutMs });
    if (probed.length > 0) return { sheets: probed, method: "probe" };
    const err = new Error(
      "Không liệt kê được worksheet (HTML: " + (htmlErr && htmlErr.message) + ")."
    );
    err.cause = htmlErr;
    throw err;
  }
}

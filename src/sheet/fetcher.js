// Public CSV fetcher for Google Spreadsheets (Phase 2).
// No schedule data is hard-coded here. Pure transport only.

import { FETCH_DEFAULTS, buildCsvExportUrl } from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Fetch one sheet tab as CSV text via public export URL.
 * @param {object} args
 * @param {string} args.spreadsheetId
 * @param {string} args.gid
 * @param {number} [args.timeoutMs]
 * @param {number} [args.retries] - number of RETRIES after the first attempt (bounded)
 * @param {number} [args.baseDelayMs]
 * @param {Function} [args.fetchFn] - injectable for tests (defaults to global fetch)
 * @returns {Promise<string>} CSV text
 */
export async function fetchSheetCsv({
  spreadsheetId,
  gid,
  timeoutMs = FETCH_DEFAULTS.timeoutMs,
  retries = FETCH_DEFAULTS.retries,
  baseDelayMs = FETCH_DEFAULTS.baseDelayMs,
  fetchFn = globalThis.fetch,
}) {
  if (!spreadsheetId) throw new Error("spreadsheetId is required");
  if (gid === undefined || gid === null || gid === "") {
    throw new Error("gid is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const maxRetries = Math.max(0, Math.min(Math.trunc(retries), 5));
  const url = buildCsvExportUrl(spreadsheetId, gid);

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} fetching gid=${gid}`);
        err.status = res.status;
        // 4xx (except 429) means permission / bad gid: do not retry
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        if (!isRetriableStatus(res.status)) throw err;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      const isAbort =
        err && (err.name === "AbortError" || String(err.message).includes("aborted"));
      const status = err && err.status;
      const retriable =
        isAbort || status === undefined || status === 429 || isRetriableStatus(status);
      // Non-retriable client errors fail fast
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt >= maxRetries || !retriable) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("fetch failed");
}

// Spreadsheet source configuration (Phase 2).
// Parser must NOT hard-code T01-T17. Week/gid mapping lives here only.

export const SPREADSHEET_ID = "1Ucbd4p6l15hKjSUiChBT0KjcLvF2SHcP";

export const FETCH_DEFAULTS = {
  timeoutMs: 15000,
  retries: 3,
  baseDelayMs: 500,
};

// Example mapping. Add new weeks here without touching the parser.
// week: logical label passed through to PracticeSession.week
// gid: Google sheet tab id
export const SHEET_SOURCES = [
  { week: "T01", gid: "1201125911" },
];

export function buildCsvExportUrl(spreadsheetId, gid) {
  if (!spreadsheetId) throw new Error("spreadsheetId is required");
  if (!gid) throw new Error("gid is required");
  return (
    "https://docs.google.com/spreadsheets/d/" +
    encodeURIComponent(spreadsheetId) +
    "/export?format=csv&gid=" +
    encodeURIComponent(String(gid))
  );
}

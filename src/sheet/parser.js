// Core parser: CSV of one week -> PracticeSession[] (Phase 2).
// Pure functions, no UI / DB / network / notification dependencies.
// Keeps cellRaw everywhere for debugging. Never guesses class hours.

/**
 * @typedef {"MORNING"|"AFTERNOON"} SessionSlot
 * @typedef {object} PracticeSession
 * @property {string} week
 * @property {string} date        // ISO yyyy-MM-dd parsed from the date header row
 * @property {string} weekday     // raw weekday header, e.g. "Thứ 3"
 * @property {SessionSlot} session // MORNING | AFTERNOON only
 * @property {string} room        // raw room cell
 * @property {string|null} courseCode
 * @property {string|null} groupCode
 * @property {string|null} courseRaw
 * @property {string|null} titleRaw
 * @property {string|null} teacherRaw
 * @property {string} cellRaw
 */

// ---------- CSV (RFC4180 subset: quotes, commas, multiline) ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\r") {
        // ignore, \n handles the break
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }
  // trailing field
  row.push(field);
  // drop single empty artifact of empty input
  if (row.length === 1 && row[0] === "" && rows.length === 0) return [];
  rows.push(row);
  return rows;
}

// ---------- small normalizers ----------

function strip(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function removeDiacriticsLower(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeSessionLabel(s) {
  return removeDiacriticsLower(strip(s));
}

function isMorningLabel(s) {
  const n = normalizeSessionLabel(s);
  return n === "sang" || n.startsWith("sang");
}

function isAfternoonLabel(s) {
  const n = normalizeSessionLabel(s);
  return n === "chieu" || n.startsWith("chieu");
}

// dd/MM/yyyy (or d/M/yy) -> yyyy-MM-dd, null when unparsable
export function parseDateCell(s) {
  const t = strip(s);
  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let d = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// Keep raw cell text for debugging: trim edges, preserve internal line breaks.
export function preserveCellRaw(s) {
  return String(s || "")
    .split("\n")
    .map((x) => x.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// ---------- teacher ----------

// Allows typo with missing space: "ThầyLHQ Bảo"
const TEACHER_RE = /^(thầy|cô|thay|co)\s*(.*)$/iu;

export function isTeacherLine(line) {
  return TEACHER_RE.test(strip(line));
}

// ---------- course / group ----------

// Main case: "CT005-D04" -> { courseCode: "CT005", groupCode: "D04" }
const CODE_DASH_GROUP_RE = /^([A-Z]{2,4}\d{2,5})\s*[-–]\s*([A-Z0-9]{1,10})$/i;
// Fused course+group without dash: "CT31201" -> { course: "CT312", group: "01" }.
// Real source survey: course codes are PREFIX + exactly 3 digits (CT005..CT999)
// and fused trailing 2 digits act as the group (CT31201, CT49501, CT17701...).
// Letter-infix codes (CT106HM01, CT100D03) never match: the char before the
// final 2 digits must itself be a digit. Tokens that already carry a dashed
// group (CT22301-QLDAPM) take the dashed branch first and never reach here.
const FUSED_RE = /^([A-Z]{2,4}\d{3})(\d{2})$/i;

export function splitFusedToken(token) {
  const t = strip(token);
  const m = t.match(FUSED_RE);
  if (!m) return null;
  return { courseCode: m[1].toUpperCase(), groupCode: m[2].toUpperCase(), courseRaw: t };
}

// Fallback course-like token without a clear group: "CT106HM01", "CT100D03", "CT17"
const COURSE_TOKEN_RE = /^[A-Z]{2,4}\d{2,}[A-Z]*\d*$/i;

// Split "TOKEN - title" on the first " - " style separator.
function splitTokenTitle(line) {
  const m = strip(line).match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (m) return { token: strip(m[1]), title: strip(m[2]) };
  return { token: strip(line), title: null };
}

export function parseCourseLine(line) {
  const clean = strip(line);
  if (!clean) return null;
  if (isTeacherLine(clean)) return null;
  // Three-part form with spaces: "CT005 - D04 - NT CNS"
  const full = clean.match(
    /^([A-Z]{2,4}\d{2,5})\s*[-–]\s*([A-Z0-9]{1,10})\s+[-–]\s+(.+)$/i
  );
  if (full) {
    return {
      courseCode: full[1].toUpperCase(),
      groupCode: full[2].toUpperCase(),
      courseRaw: `${strip(full[1])} - ${strip(full[2])}`,
      titleRaw: strip(full[3]),
    };
  }
  const { token, title } = splitTokenTitle(clean);
  const mg = token.match(CODE_DASH_GROUP_RE);
  if (mg) {
    return {
      courseCode: mg[1].toUpperCase(),
      groupCode: mg[2].toUpperCase(),
      courseRaw: token,
      titleRaw: title,
    };
  }
  // Fused form without dash: CT31201 -> CT312 + 01 (never invent other splits).
  const fused = splitFusedToken(token);
  if (fused) {
    return {
      courseCode: fused.courseCode,
      groupCode: fused.groupCode,
      courseRaw: fused.courseRaw,
      titleRaw: title,
    };
  }
  if (COURSE_TOKEN_RE.test(token)) {
    // Known-unknown: keep raw token as courseCode, group stays null.
    // Never invent a split rule for these.
    return {
      courseCode: token.toUpperCase(),
      groupCode: null,
      courseRaw: token,
      titleRaw: title,
    };
  }
  // Non-course event: "Quản lý dự án (VLVH)", "Bồi dưỡng kiến thức..."
  return {
    courseCode: null,
    groupCode: null,
    courseRaw: null,
    titleRaw: clean,
  };
}

/**
 * Normalize user query variants so all of these can match CT005-D04:
 * "ct005", "ct005-d04", "CT005 - D04", "ct005 - d04"
 * Returns { courseCode, groupCode } upper-cased, groupCode may be null.
 */
export function normalizeCourseQuery(input) {
  const t = strip(input).toUpperCase().replace(/\s*[-–]\s*/g, "-").replace(/\s+/g, "");
  if (!t) return { courseCode: null, groupCode: null };
  const m = t.match(/^([A-Z]{2,4}\d{2,5})-([A-Z0-9]{1,10})$/);
  if (m) return { courseCode: m[1], groupCode: m[2] };
  // Fused input without dash: CT31201 -> CT312 + 01 (same rule as the parser).
  const fused = splitFusedToken(t);
  if (fused) return { courseCode: fused.courseCode, groupCode: fused.groupCode };
  if (COURSE_TOKEN_RE.test(t)) return { courseCode: t, groupCode: null };
  return { courseCode: t, groupCode: null };
}

/** Subscription match: course must match; group matches when query specifies one. */
export function matchesSubscription(session, query) {
  const q = typeof query === "string" ? normalizeCourseQuery(query) : query;
  if (!session || !session.courseCode || !q || !q.courseCode) return false;
  if (session.courseCode.toUpperCase() !== String(q.courseCode).toUpperCase()) return false;
  if (q.groupCode) {
    return (session.groupCode || "").toUpperCase() === String(q.groupCode).toUpperCase();
  }
  return true;
}

// ---------- main week parser ----------

function findHeaderRow(rows) {
  for (let r = 0; r < rows.length; r++) {
    const a = strip(rows[r][0] || "");
    const b = strip(rows[r][1] || "");
    if (
      removeDiacriticsLower(a).startsWith("buoi") &&
      removeDiacriticsLower(b).startsWith("phong")
    ) {
      return r;
    }
  }
  return -1;
}

/**
 * Parse one week CSV.
 * @param {string} csvText
 * @param {object} opts
 * @param {string} opts.week - logical week label, e.g. "T01" (never inferred from dates)
 * @returns {{ sessions: PracticeSession[], warnings: object[] }}
 */
export function parseWeekCsv(csvText, opts = {}) {
  const week = opts.week || "";
  const warnings = [];
  const sessions = [];
  const warn = (row, col, reason, cellRaw) => {
    warnings.push({ row, col, reason, cellRaw: String(cellRaw || "").slice(0, 500) });
  };

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    warn(0, 0, "empty_csv", "");
    return { sessions, warnings };
  }
  const headerRow = findHeaderRow(rows);
  if (headerRow === -1) {
    warn(0, 0, "header_row_not_found", rows[0].join(",").slice(0, 200));
    return { sessions, warnings };
  }
  const weekdayRow = rows[headerRow];
  const dateRow = rows[headerRow + 1] || [];

  // Day columns: C..I (index 2..8). Map each to { weekday, date }.
  const dayCols = [];
  for (let c = 2; c <= 8; c++) {
    const weekday = strip(weekdayRow[c] || "");
    const dateRaw = strip(dateRow[c] || "");
    const date = parseDateCell(dateRaw);
    if (!date) {
      warn(headerRow + 1, c, "unparsable_date", dateRaw);
      continue;
    }
    dayCols.push({ col: c, weekday, date });
  }
  if (dayCols.length === 0) {
    warn(headerRow + 1, 2, "no_parsable_dates", dateRow.join(",").slice(0, 200));
    return { sessions, warnings };
  }

  // Forward-fill MORNING/AFTERNOON from column A.
  let current = null; // "MORNING" | "AFTERNOON" | null
  for (let r = headerRow + 2; r < rows.length; r++) {
    const label = rows[r][0] || "";
    if (isMorningLabel(label)) current = "MORNING";
    else if (isAfternoonLabel(label)) current = "AFTERNOON";
    if (!current) continue; // rows before first SÁNG marker

    const room = strip(rows[r][1] || "");
    if (!room) continue; // no room => not a schedule row

    for (const { col, weekday, date } of dayCols) {
      const cellRaw = String(rows[r][col] ?? "");
      if (!strip(cellRaw)) continue; // empty cell: skip silently
      const lines = cellRaw
        .split("\n")
        .map((x) => strip(x))
        .filter((x) => x.length > 0);
      if (lines.length === 0) continue;

      const teacherLines = lines.filter((l) => isTeacherLine(l));
      const courseLines = lines.filter((l) => !isTeacherLine(l));
      const teacherRaw = teacherLines.length > 0 ? teacherLines.join(" / ") : null;

      if (courseLines.length === 0) {
        // Only a teacher name, no course info: preserve raw, null course.
        sessions.push({
          week,
          date,
          weekday,
          session: current,
          room,
          courseCode: null,
          groupCode: null,
          courseRaw: null,
          titleRaw: null,
          teacherRaw,
          cellRaw: preserveCellRaw(cellRaw),
        });
        warn(r, col, "teacher_only_cell", cellRaw);
        continue;
      }

      const parsed = courseLines.map((l) => {
        try {
          return parseCourseLine(l);
        } catch (e) {
          warn(r, col, "course_line_crash:" + String((e && e.message) || e), l);
          return { courseCode: null, groupCode: null, courseRaw: null, titleRaw: l };
        }
      });

      if (courseLines.length > 1) {
        warn(r, col, "multi_course_cell", cellRaw);
      }
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        if (!p) {
          warn(r, col, "unparsable_course_line", courseLines[i]);
          sessions.push({
            week,
            date,
            weekday,
            session: current,
            room,
            courseCode: null,
            groupCode: null,
            courseRaw: null,
            titleRaw: courseLines[i],
            teacherRaw,
            cellRaw: preserveCellRaw(cellRaw),
          });
          continue;
        }
        if (!p.courseCode) {
          warn(r, col, "non_course_event", courseLines[i]);
        }
        sessions.push({
          week,
          date,
          weekday,
          session: current,
          room,
          courseCode: p.courseCode,
          groupCode: p.groupCode,
          courseRaw: p.courseRaw,
          titleRaw: p.titleRaw,
          teacherRaw,
          cellRaw: preserveCellRaw(cellRaw),
        });
      }
    }
  }

  return { sessions, warnings };
}

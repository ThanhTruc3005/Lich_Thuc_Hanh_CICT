// Sync: fetch CSV server-side -> parse (reused) -> upsert with change detection.
// Detects NEW / CHANGED / REMOVED and writes notifications. Idempotent on re-sync.

import crypto from "node:crypto";
import { fetchSheetCsv } from "./sheet/fetcher.js";
import { parseWeekCsv } from "./sheet/parser.js";
import {
  getSessionByIdentity,
  insertSession,
  updateSession,
  deactivateSessionsNotIn,
  subscriptionsMatchingSession,
  addNotification,
  recordChange,
  upsertSyncState,
} from "./db.js";
import { todayISO, slotLabel } from "./reminders.js";
import { splitFusedToken } from "./sheet/parser.js";

// ---------- null-safe display (never render "null"/"undefined"/"N/A") ----------

export function formatOptional(value) {
  const t = String(value ?? "").trim();
  return t ? t : null;
}

// Accepts parsed sessions (camelCase) or DB rows (snake_case).
export function normalizeForDisplay(s) {
  const r = s || {};
  return {
    courseCode: formatOptional(r.courseCode ?? r.course_code),
    groupCode: formatOptional(r.groupCode ?? r.group_code),
    courseName: formatOptional(r.courseName ?? r.titleRaw ?? r.title_raw),
    teacher: formatOptional(r.teacher ?? r.teacherRaw ?? r.teacher_raw),
    weekday: formatOptional(r.weekday),
    slot: r.slot || r.session || null,
    room: formatOptional(r.room),
    date: formatOptional(r.date),
    courseRaw: formatOptional(r.courseRaw ?? r.course_raw),
  };
}

export function courseHeadline(s) {
  const d = normalizeForDisplay(s);
  const code = d.courseCode || d.courseRaw || "Môn học";
  return d.courseName ? `${code} - ${d.courseName}` : code;
}

// One info block, only lines with real data. No exact times ever.
export function sessionCardLines(s) {
  const d = normalizeForDisplay(s);
  const lines = [courseHeadline(d)];
  if (d.groupCode) lines.push(`Nhóm ${d.groupCode}`);
  const when = [d.weekday, d.slot ? slotLabel(d.slot) : null].filter(Boolean).join(" · ");
  if (when) lines.push(when);
  if (d.room) lines.push(`Phòng ${d.room}`);
  if (d.teacher) lines.push(d.teacher);
  return lines;
}

const COMPARE_FIELDS = ["room", "teacherRaw", "titleRaw", "weekday"];

function hashShort(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

// Stable identity for one parsed session.
// Room is deliberately NOT part of the key so a room move is a CHANGE, not add+remove.
export function identityKey(sourceGid, p) {
  if (p.courseCode && p.groupCode) {
    return [sourceGid, p.date, p.session, p.courseCode, p.groupCode].join("|");
  }
  if (p.courseCode) {
    return [sourceGid, p.date, p.session, p.courseCode, "nogroup"].join("|");
  }
  return [sourceGid, p.date, p.session, "event", hashShort(p.cellRaw)].join("|");
}

function fieldDiff(oldRow, p) {
  const diffs = [];
  const pairs = [
    ["room", oldRow.room, p.room],
    ["teacherRaw", oldRow.teacher_raw, p.teacherRaw],
    ["titleRaw", oldRow.title_raw, p.titleRaw],
    ["weekday", oldRow.weekday, p.weekday],
  ];
  for (const [field, oldV, newV] of pairs) {
    if ((oldV || null) !== (newV || null)) diffs.push({ field, oldValue: oldV, newValue: newV });
  }
  return diffs;
}

function changeBody(diffs) {
  const labels = { room: "Phòng", teacherRaw: "GV", titleRaw: "Môn", weekday: "Thứ" };
  return diffs.map((d) => `${labels[d.field] || d.field}: ${d.oldValue || "—"} → ${d.newValue || "—"}`).join("; ");
}

/**
 * Sync one week tab. Pass csvText in tests to avoid network.
 * @returns {Promise<{week, sourceGid, added, changed, removed, total, warnings}>}
 */
export async function syncWeek(db, { week, sourceGid, spreadsheetId, csvText = null, fetchFn, today = todayISO() }) {
  let csv = csvText;
  if (csv === null) {
    csv = await fetchSheetCsv({ spreadsheetId, gid: sourceGid, fetchFn });
  }
  const { sessions: parsed, warnings } = parseWeekCsv(csv, { week });

  // De-duplicate identical identities inside one parse (same group twice, two rooms).
  const seen = new Set();
  const unique = [];
  for (const p of parsed) {
    let key = identityKey(sourceGid, p);
    if (seen.has(key)) key = `${key}|${p.room}`;
    seen.add(key);
    unique.push({ key, p });
  }

  let added = 0;
  const changed = [];
  for (const { key, p } of unique) {
    const existing = getSessionByIdentity(db, key);
    if (!existing) {
      const id = insertSession(db, {
        identityKey: key, week, date: p.date, weekday: p.weekday, slot: p.session,
        room: p.room, courseCode: p.courseCode, groupCode: p.groupCode,
        courseRaw: p.courseRaw, titleRaw: p.titleRaw, teacherRaw: p.teacherRaw,
        cellRaw: p.cellRaw, sourceGid,
      });
      added++;
      notifyNew(db, { ...p, id, course_code: p.courseCode, group_code: p.groupCode }, today);
    } else {
      const diffs = fieldDiff(existing, p);
      updateSession(db, existing.id, {
        room: p.room, teacherRaw: p.teacherRaw, titleRaw: p.titleRaw,
        weekday: p.weekday, week, cellRaw: p.cellRaw,
      });
      if (existing.active === 0) {
        added++; // re-appeared after being removed
        notifyNew(db, { ...p, id: existing.id, course_code: p.courseCode, group_code: p.groupCode }, today);
      } else if (diffs.length > 0) {
        for (const d of diffs) {
          recordChange(db, { sessionId: existing.id, field: d.field, oldValue: d.oldValue, newValue: d.newValue });
        }
        changed.push({ sessionId: existing.id, diffs });
        notifyChanged(db, existing, p, diffs);
      }
    }
  }

  const removed = deactivateSessionsNotIn(db, sourceGid, [...seen]);
  for (const r of removed) notifyRemoved(db, r);

  ensureNearestReminders(db, { today });
  const total = unique.length;
  upsertSyncState(db, { sourceGid, week, status: "OK", sessionCount: total });
  return { week, sourceGid, added, changed: changed.length, removed: removed.length, total, warnings: warnings.length };
}

function notifyNew(db, session, today) {
  for (const sub of subscriptionsMatchingSession(db, session)) {
    const d = normalizeForDisplay(session);
    const head = d.groupCode ? `${d.courseCode} · Nhóm ${d.groupCode}` : (d.courseCode || "Lịch mới");
    addNotification(db, {
      subscriptionId: sub.id,
      sessionId: session.id,
      type: "NEW_SESSION",
      title: `Lịch mới: ${head}`,
      body: sessionCardLines(session).join("\n"),
      scheduledFor: d.date,
    });
  }
}

function notifyChanged(db, oldRow, p, diffs) {
  const session = { ...oldRow, course_code: oldRow.course_code, group_code: oldRow.group_code };
  for (const sub of subscriptionsMatchingSession(db, session)) {
    const d = normalizeForDisplay(oldRow);
    const head = d.groupCode ? `${d.courseCode} · Nhóm ${d.groupCode}` : (d.courseCode || "Lịch học");
    addNotification(db, {
      subscriptionId: sub.id,
      sessionId: oldRow.id,
      type: "SCHEDULE_CHANGED",
      title: `Lịch đã thay đổi: ${head}`,
      body: `⚠️ ${changeBody(diffs)}.\n` + sessionCardLines(p).join("\n"),
      scheduledFor: d.date,
    });
  }
}

function notifyRemoved(db, row) {
  for (const sub of subscriptionsMatchingSession(db, row)) {
    const d = normalizeForDisplay(row);
    const head = d.groupCode ? `${d.courseCode} · Nhóm ${d.groupCode}` : (d.courseCode || "Lịch học");
    addNotification(db, {
      subscriptionId: sub.id,
      sessionId: row.id,
      type: "SCHEDULE_REMOVED",
      title: `Lịch bị huỷ: ${head}`,
      body: `Buổi học này không còn trong lịch trường.\n` + sessionCardLines(row).join("\n"),
      scheduledFor: d.date,
    });
  }
}

// Nearest-only reminders: exactly ONE pending NEAREST row per subscription -
// today's earliest session (MORNING first) if any, else the nearest future one.
// Legacy bulk UPCOMING rows are retired so the far future is never spammed.
export function ensureNearestReminders(db, { today = todayISO() } = {}) {
  db.prepare(`UPDATE notifications SET status = 'SUPERSEDED' WHERE type = 'UPCOMING' AND status = 'PENDING'`).run();
  const subs = db.prepare(`SELECT * FROM subscriptions WHERE notification_enabled = 1`).all();
  let created = 0;
  for (const sub of subs) {
    const next = db
      .prepare(
        `SELECT * FROM sessions WHERE active = 1 AND course_code = ? AND group_code = ?
         AND date >= ? ORDER BY date ASC,
         CASE slot WHEN 'MORNING' THEN 0 ELSE 1 END, room ASC LIMIT 1`
      )
      .get(sub.course_code, sub.group_code, today);
    db.prepare(`DELETE FROM notifications WHERE subscription_id = ? AND type = 'NEAREST'`).run(sub.id);
    if (!next) continue;
    const isToday = next.date === today;
    addNotification(db, {
      subscriptionId: sub.id,
      sessionId: next.id,
      type: "NEAREST",
      title: isToday ? "🔔 Lịch học hôm nay" : "🔔 Lịch học gần nhất",
      body: sessionCardLines(next).join("\n"),
      scheduledFor: next.date,
    });
    created++;
  }
  return created;
}

// One-time repair for notification rows written by older code with literal
// "null"/"undefined" in title/body (e.g. "Lịch mới: CT312-null").
// Rebuilds text from the linked session with null-safe helpers; rows whose
// session is gone are retired. Idempotent.
export function repairLegacyNotifications(db) {
  const rows = db
    .prepare(
      `SELECT * FROM notifications WHERE status = 'PENDING' AND
       (title LIKE '%null%' OR title LIKE '%undefined%' OR body LIKE '%null%' OR body LIKE '%undefined%')`
    )
    .all();
  let repaired = 0;
  let retired = 0;
  for (const n of rows) {
    const s = n.session_id
      ? db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(n.session_id)
      : null;
    if (!s) {
      db.prepare(`UPDATE notifications SET status = 'SUPERSEDED' WHERE id = ?`).run(n.id);
      retired++;
      continue;
    }
    const d = normalizeForDisplay(s);
    const head = d.groupCode ? `${d.courseCode} · Nhóm ${d.groupCode}` : d.courseCode || "Lịch học";
    const prefix =
      n.type === "SCHEDULE_CHANGED"
        ? "Lịch đã thay đổi: "
        : n.type === "SCHEDULE_REMOVED"
          ? "Lịch bị huỷ: "
          : n.type === "NEW_SESSION"
            ? "Lịch mới: "
            : "";
    db.prepare(`UPDATE notifications SET title = ?, body = ? WHERE id = ?`).run(
      prefix + head,
      sessionCardLines(s).join("\n"),
      n.id
    );
    repaired++;
  }
  return { repaired, retired };
}

function slotRank(slot) {
  return slot === "AFTERNOON" ? 1 : 0;
}

// Dashboard reminder: exactly ONE nearest session across all of the user's
// subscriptions — today's earliest (MORNING first) if any, else nearest future.
// The backend decides; the frontend never filters a list. No exact times used.
export function getNearestReminder(db, clientId, { today = todayISO() } = {}) {
  const subs = db
    .prepare(`SELECT * FROM subscriptions WHERE client_id = ? AND notification_enabled = 1 ORDER BY id ASC`)
    .all(clientId);
  let best = null;
  for (const sub of subs) {
    const s = db
      .prepare(
        `SELECT * FROM sessions WHERE active = 1 AND course_code = ? AND group_code = ?
         AND date >= ? ORDER BY date ASC,
         CASE slot WHEN 'MORNING' THEN 0 ELSE 1 END, room ASC LIMIT 1`
      )
      .get(sub.course_code, sub.group_code, today);
    if (!s) continue;
    if (
      !best ||
      s.date < best.session.date ||
      (s.date === best.session.date && slotRank(s.slot) < slotRank(best.session.slot))
    ) {
      best = { subscription: sub, session: s };
    }
  }
  return best;
}
export function migrateFusedGroups(db) {
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE group_code IS NULL AND course_code GLOB '*[0-9][0-9]'`)
    .all();
  let migrated = 0;
  let merged = 0;
  for (const r of rows) {
    const f = splitFusedToken(r.course_code || "");
    if (!f) continue;
    const base = [r.source_gid, r.date, r.slot, f.courseCode, f.groupCode].join("|");
    // Preserve any dedupe suffix (e.g. "|P105" for parallel rooms sharing one
    // identity), otherwise two rooms collapse into one row and data is lost.
    const parts = String(r.identity_key).split("|");
    const suffix = parts.length > 5 ? "|" + parts.slice(5).join("|") : "";
    const newKey = base + suffix;
    const clash = getSessionByIdentity(db, newKey);
    if (clash && clash.id !== r.id) {
      db.prepare(`UPDATE sessions SET active = 0, updated_at = ? WHERE id = ?`).run(
        new Date().toISOString(), r.id
      );
      merged++;
      continue;
    }
    db.prepare(
      `UPDATE sessions SET course_code = ?, group_code = ?, identity_key = ?, updated_at = ? WHERE id = ?`
    ).run(f.courseCode, f.groupCode, newKey, new Date().toISOString(), r.id);
    migrated++;
  }
  return { migrated, merged };
}

export function parseSheetSources(envValue) {
  // "T01:1201125911,T02:xxxx" -> [{week, gid}]
  // Used only as seed/fallback: live discovery provides the real tab list.
  return String(envValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [week, gid] = pair.split(":").map((x) => (x || "").trim());
      if (!week || !gid) throw new Error(`Invalid sheet source: "${pair}" (expected WEEK:gid)`);
      return { week, gid };
    });
}

// Canonical per-sheet key. Sheets discovered without a gid (name-only fallback)
// use "name:T02" until adoptGid() migrates them to the real gid.
export function sheetKey(sheet) {
  if (sheet && sheet.gid) return String(sheet.gid);
  return "name:" + (sheet && (sheet.week || sheet.name));
}

/**
 * Sync many week tabs. One failing sheet never fails the whole run:
 * its error is recorded in sync_state and sync continues.
 * Idempotent: re-running with unchanged source data yields added=0/changed=0/removed=0.
 *
 * @param {object} db
 * @param {object} args
 * @param {Array<{week, gid|null}>} args.sheets
 * @param {(sheet) => Promise<string>} args.fetchCsv - resolves raw CSV text per sheet
 * @returns {Promise<{weeks, totals}>}
 */
export async function syncAllWeeks(db, { sheets, fetchCsv, today = todayISO(), logger = console }) {
  const log = (msg) => {
    try {
      logger.log(msg);
    } catch {
      // logging must never break sync
    }
  };
  log("SYNC START (" + new Date().toISOString() + ")");
  const names = (sheets || []).map((s) => s.week);
  log("Discovered worksheets (" + names.length + "): " + (names.join(", ") || "(none)"));

  const weeks = [];
  const totals = { added: 0, changed: 0, removed: 0, total: 0, unchanged: 0 };
  for (const sheet of sheets || []) {
    log("Syncing " + sheet.week + "...");
    const key = sheetKey(sheet);
    try {
      const csv = await fetchCsv(sheet);
      const r = await syncWeek(db, {
        week: sheet.week,
        sourceGid: key,
        spreadsheetId: null,
        csvText: csv,
        today,
      });
      weeks.push({ ...r, status: "OK" });
      totals.added += r.added;
      totals.changed += r.changed;
      totals.removed += r.removed;
      totals.total += r.total;
      log("  " + sheet.week + ": OK (total=" + r.total + " added=" + r.added + " changed=" + r.changed + " removed=" + r.removed + " warnings=" + r.warnings + ")");
    } catch (e) {
      const reason = String((e && e.message) || e).slice(0, 300);
      upsertSyncState(db, { sourceGid: key, week: sheet.week, status: "ERROR", error: reason });
      weeks.push({ week: sheet.week, sourceGid: key, status: "FAILED", error: reason });
      log("  " + sheet.week + ": FAILED reason: " + reason);
    }
  }
  totals.unchanged = totals.total - totals.added - totals.changed - totals.removed;
  log(
    "SYNC RESULT added=" + totals.added + " changed=" + totals.changed +
    " removed=" + totals.removed + " unchanged=" + totals.unchanged +
    " total=" + totals.total + " worksheets=" + weeks.length
  );
  return { weeks, totals };
}

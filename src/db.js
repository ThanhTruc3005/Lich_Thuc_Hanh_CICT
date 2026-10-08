// SQLite storage (MVP). Zero dependencies, uses built-in node:sqlite.
// Tables: sessions, subscriptions, notifications, session_changes, sync_state.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function utcNow() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_key TEXT NOT NULL UNIQUE,
  week TEXT NOT NULL,
  date TEXT NOT NULL,
  weekday TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('MORNING','AFTERNOON')),
  room TEXT NOT NULL,
  course_code TEXT,
  group_code TEXT,
  course_raw TEXT,
  title_raw TEXT,
  teacher_raw TEXT,
  cell_raw TEXT NOT NULL,
  source_gid TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup
  ON sessions (source_gid, active, course_code, group_code, date);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  course_code TEXT NOT NULL,
  group_code TEXT NOT NULL,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (client_id, course_code, group_code)
);
CREATE INDEX IF NOT EXISTS idx_subs_client ON subscriptions (client_id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, type, session_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_notif_sub ON notifications (subscription_id, status, created_at);
CREATE TABLE IF NOT EXISTS session_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  source_gid TEXT PRIMARY KEY,
  week TEXT NOT NULL,
  last_sync_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'NEVER',
  last_error TEXT,
  session_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discovered_sheets (
  name TEXT PRIMARY KEY,
  gid TEXT,
  last_seen_at TEXT NOT NULL
);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

// ---------- subscriptions ----------

export function createSubscription(db, { clientId, courseCode, groupCode }) {
  const now = utcNow();
  try {
    const r = db
      .prepare(
        `INSERT INTO subscriptions (client_id, course_code, group_code, notification_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(clientId, courseCode, groupCode, now, now);
    return { subscription: getSubscriptionById(db, Number(r.lastInsertRowid)), created: true };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      const existing = db
        .prepare(
          `SELECT * FROM subscriptions WHERE client_id = ? AND course_code = ? AND group_code = ?`
        )
        .get(clientId, courseCode, groupCode);
      return { subscription: existing, created: false };
    }
    throw e;
  }
}

export function getSubscriptionById(db, id) {
  return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id) || null;
}

export function listSubscriptions(db, clientId) {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE client_id = ? ORDER BY created_at ASC`)
    .all(clientId);
}

export function deleteSubscription(db, clientId, id) {
  const r = db
    .prepare(`DELETE FROM subscriptions WHERE id = ? AND client_id = ?`)
    .run(id, clientId);
  return r.changes > 0;
}

export function subscriptionsMatchingSession(db, session) {
  if (!session.course_code) return [];
  if (session.group_code) {
    return db
      .prepare(
        `SELECT * FROM subscriptions WHERE course_code = ? AND group_code = ? AND notification_enabled = 1`
      )
      .all(session.course_code, session.group_code);
  }
  return db
    .prepare(`SELECT * FROM subscriptions WHERE course_code = ? AND notification_enabled = 1`)
    .all(session.course_code);
}

// ---------- sessions ----------

export function getSessionByIdentity(db, identityKey) {
  return db.prepare(`SELECT * FROM sessions WHERE identity_key = ?`).get(identityKey) || null;
}

export function insertSession(db, row) {
  const now = utcNow();
  const r = db
    .prepare(
      `INSERT INTO sessions
        (identity_key, week, date, weekday, slot, room, course_code, group_code,
         course_raw, title_raw, teacher_raw, cell_raw, source_gid, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      row.identityKey, row.week, row.date, row.weekday, row.slot, row.room,
      row.courseCode, row.groupCode, row.courseRaw, row.titleRaw,
      row.teacherRaw, row.cellRaw, row.sourceGid, now, now
    );
  return Number(r.lastInsertRowid);
}

export function updateSession(db, id, fields) {
  const now = utcNow();
  db.prepare(
    `UPDATE sessions SET room = ?, teacher_raw = ?, title_raw = ?, weekday = ?, week = ?,
       cell_raw = ?, active = 1, updated_at = ? WHERE id = ?`
  ).run(
    fields.room, fields.teacherRaw, fields.titleRaw, fields.weekday,
    fields.week, fields.cellRaw, now, id
  );
}

export function deactivateSessionsNotIn(db, sourceGid, identityKeys) {
  if (identityKeys.length === 0) {
    return db
      .prepare(`SELECT * FROM sessions WHERE source_gid = ? AND active = 1`)
      .all(sourceGid);
  }
  const placeholders = identityKeys.map(() => "?").join(",");
  const removed = db
    .prepare(
      `SELECT * FROM sessions WHERE source_gid = ? AND active = 1 AND identity_key NOT IN (${placeholders})`
    )
    .all(sourceGid, ...identityKeys);
  db.prepare(
    `UPDATE sessions SET active = 0, updated_at = ? WHERE source_gid = ? AND active = 1
     AND identity_key NOT IN (${placeholders})`
  ).run(utcNow(), sourceGid, ...identityKeys);
  return removed;
}

export function querySessionsForSubscriptions(db, subs, { fromDate = "0000-00-00", includeInactive = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const sub of subs) {
    const rows = db
      .prepare(
        `SELECT * FROM sessions
         WHERE course_code = ? AND group_code = ? AND date >= ?
           ${includeInactive ? "" : "AND active = 1"}
         ORDER BY date ASC, slot ASC`
      )
      .all(sub.course_code, sub.group_code, fromDate);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, subscription_id: sub.id });
    }
  }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.slot).localeCompare(String(b.slot)));
  return out;
}

// ---------- notifications ----------

export function addNotification(db, { subscriptionId, sessionId = 0, type, title, body, scheduledFor = null }) {
  const now = utcNow();
  try {
    const r = db
      .prepare(
        `INSERT INTO notifications
          (subscription_id, session_id, type, title, body, scheduled_for, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`
      )
      .run(subscriptionId, sessionId, type, title, body, scheduledFor, now);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return null; // already notified
    throw e;
  }
}

export function listNotifications(db, clientId, { limit = 50 } = {}) {
  // Only actionable rows: retired (SUPERSEDED) history must never resurface in UI.
  return db
    .prepare(
      `SELECT n.*, s.date AS session_date, s.slot AS session_slot, s.room AS session_room,
              s.course_code, s.group_code, s.week AS session_week, s.teacher_raw AS session_teacher,
              s.title_raw AS session_course_name
       FROM notifications n
       JOIN subscriptions sub ON sub.id = n.subscription_id
       LEFT JOIN sessions s ON s.id = n.session_id
       WHERE sub.client_id = ? AND n.status = 'PENDING'
       ORDER BY n.created_at DESC
       LIMIT ?`
    )
    .all(clientId, limit);
}

// ---------- changes + sync state ----------

export function recordChange(db, { sessionId, field, oldValue, newValue }) {
  db.prepare(
    `INSERT INTO session_changes (session_id, field, old_value, new_value, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, field, oldValue ?? null, newValue ?? null, utcNow());
}

export function listChangesForSession(db, sessionId) {
  return db
    .prepare(`SELECT * FROM session_changes WHERE session_id = ? ORDER BY created_at DESC`)
    .all(sessionId);
}

export function upsertSyncState(db, { sourceGid, week, status, error = null, sessionCount = null }) {
  const existing = db.prepare(`SELECT * FROM sync_state WHERE source_gid = ?`).get(sourceGid);
  if (!existing) {
    db.prepare(
      `INSERT INTO sync_state (source_gid, week, last_sync_at, last_status, last_error, session_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sourceGid, week, utcNow(), status, error, sessionCount ?? 0);
  } else {
    db.prepare(
      `UPDATE sync_state SET week = ?, last_sync_at = ?, last_status = ?, last_error = ?,
        session_count = COALESCE(?, session_count) WHERE source_gid = ?`
    ).run(week, utcNow(), status, error, sessionCount, sourceGid);
  }
}

export function getSyncState(db) {
  return db.prepare(`SELECT * FROM sync_state ORDER BY week ASC`).all();
}

export function upsertDiscoveredSheet(db, { name, gid }) {
  db.prepare(
    `INSERT INTO discovered_sheets (name, gid, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET gid = excluded.gid, last_seen_at = excluded.last_seen_at`
  ).run(name, gid ?? null, utcNow());
}

export function getDiscoveredSheets(db) {
  return db.prepare(`SELECT * FROM discovered_sheets ORDER BY name ASC`).all();
}

export function countActiveSessions(db) {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE active = 1`).get();
  return r ? r.n : 0;
}

// Migrate rows first synced via name-based key ("name:T02") to the real gid
// once discovery learns it. Keeps identity keys stable, prevents duplicates.
export function adoptGid(db, { week, gid }) {
  const legacy = "name:" + week;
  const rows = db
    .prepare(`SELECT id, identity_key FROM sessions WHERE source_gid = ? AND week = ?`)
    .all(legacy, week);
  for (const r of rows) {
    const cut = String(r.identity_key).indexOf("|");
    const rest = cut === -1 ? "" : String(r.identity_key).slice(cut);
    db.prepare(`UPDATE sessions SET source_gid = ?, identity_key = ?, updated_at = ? WHERE id = ?`).run(
      gid, gid + rest, utcNow(), r.id
    );
  }
  return rows.length;
}

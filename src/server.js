// MVP HTTP server: static UI + JSON API. Zero dependencies (built-in node:http).
// Google Sheets is always fetched server-side (no browser CORS issues).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  querySessionsForSubscriptions,
  listNotifications,
  getSyncState,
  upsertDiscoveredSheet,
  getDiscoveredSheets,
  adoptGid,
  countActiveSessions,
} from "./db.js";
import { syncAllWeeks, sheetKey, parseSheetSources, migrateFusedGroups, repairLegacyNotifications, getNearestReminder } from "./sync.js";
import { discoverSheets, filterWeekSheets } from "./sheet/discovery.js";
import { fetchSheetCsv } from "./sheet/fetcher.js";
import { fetchSheetCsvByName } from "./sheet/gviz.js";
import { validateCourseCode, validateGroupCode, validateClientId, splitCourseGroup } from "./validation.js";
import { SPREADSHEET_ID, SHEET_SOURCES } from "./sheet/config.js";
import { sessionStatus, relativeDayLabel, formatDateDisplay, slotLabel, todayISO } from "./reminders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

export const DEFAULT_SOURCES = SHEET_SOURCES.map((s) => `${s.week}:${s.gid}`).join(",");

export function serializeSessionRow(r, today = todayISO()) {
  const status = sessionStatus(r.date, today);
  return {
    id: r.id,
    subscriptionId: r.subscription_id ?? null,
    week: r.week,
    date: r.date,
    dateDisplay: formatDateDisplay(r.date),
    weekday: r.weekday,
    slot: r.session ?? r.slot,
    slotLabel: slotLabel(r.session ?? r.slot),
    room: r.room,
    courseCode: r.course_code,
    groupCode: r.group_code,
    courseName: r.title_raw || null,
    title: r.title_raw,
    teacher: r.teacher_raw,
    status,
    relative: relativeDayLabel(r.date, today),
  };
}

function shiftISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Upcoming (all) + recent past (last 3 per subscription) so users can verify
// tracking even when the synced week has passed. No times anywhere.
export function queryScheduleWindow(db, subs, today = todayISO()) {
  const rows = querySessionsForSubscriptions(db, subs, { fromDate: shiftISO(today, -30) });
  const upcoming = [];
  const pastBySub = new Map();
  for (const r of rows) {
    if (r.date >= today) upcoming.push(r);
    else {
      if (!pastBySub.has(r.subscription_id)) pastBySub.set(r.subscription_id, []);
      pastBySub.get(r.subscription_id).push(r);
    }
  }
  const past = [];
  for (const list of pastBySub.values()) {
    past.push(...list.slice(-3));
  }
  upcoming.sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.slot).localeCompare(String(b.slot))
  );
  past.sort(
    (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.slot).localeCompare(String(a.slot))
  );
  return { upcoming, past };
}

export function createApp({
  dbPath,
  spreadsheetId = SPREADSHEET_ID,
  sources = [],
  discoverFn = null,
  fetchCsvFn = null,
  discoveryTtlMin = 360,
}) {
  const db = openDatabase(dbPath);
  try {
    const mig = migrateFusedGroups(db);
    if (mig.migrated > 0 || mig.merged > 0) {
      console.log(`Fused-group migration: migrated=${mig.migrated} merged=${mig.merged}`);
    }
  } catch (e) {
    console.error("fused-group migration failed:", (e && e.message) || e);
  }
  try {
    const rep = repairLegacyNotifications(db);
    if (rep.repaired > 0 || rep.retired > 0) {
      console.log(`Legacy notification repair: repaired=${rep.repaired} retired=${rep.retired}`);
    }
  } catch (e) {
    console.error("notification repair failed:", (e && e.message) || e);
  }
  const state = {
    syncing: false,
    lastManualSyncAt: 0,
    sheetsCache: { at: 0, sheets: null },
    discoveryMethod: null,
  };

  // Resolve the week-tab list: live discovery (cached) -> previous cache ->
  // env seed. Never throws: worst case returns the seed list (maybe empty).
  async function resolveSheets({ force = false } = {}) {
    const ttlMs = Math.max(0, discoveryTtlMin) * 60_000;
    if (!force && state.sheetsCache.sheets && Date.now() - state.sheetsCache.at < ttlMs) {
      return state.sheetsCache.sheets;
    }
    let discovered = null;
    try {
      const found = discoverFn
        ? await discoverFn()
        : await discoverSheets(spreadsheetId);
      discovered = filterWeekSheets(found.sheets).map((s) => ({
        week: s.week || s.name,
        gid: s.gid ?? null,
      }));
      state.discoveryMethod = found.method;
    } catch (e) {
      console.error("discovery failed, using cache/seed:", (e && e.message) || e);
    }
    if (!discovered) {
      const cached = getDiscoveredSheets(db)
        .filter((r) => /^T\d{1,3}$/i.test(r.name))
        .map((r) => ({ week: r.name, gid: r.gid }));
      discovered = cached.length > 0 ? cached : [];
      state.discoveryMethod = cached.length > 0 ? "cache" : "seed";
    }
    // Merge env seed: pinned fallback for names discovery missed.
    const names = new Set(discovered.map((s) => s.week));
    for (const seed of sources) {
      if (seed && seed.week && !names.has(seed.week)) {
        discovered.push({ week: seed.week, gid: seed.gid || null });
        names.add(seed.week);
      }
    }
    discovered.sort((a, b) => String(a.week).localeCompare(String(b.week)));
    // Persist + migrate any name-keyed rows to real gids.
    for (const s of discovered) {
      upsertDiscoveredSheet(db, { name: s.week, gid: s.gid });
      if (s.gid) {
        try {
          adoptGid(db, { week: s.week, gid: s.gid });
        } catch {
          // migration must never break sync
        }
      }
    }
    state.sheetsCache = { at: Date.now(), sheets: discovered };
    return discovered;
  }

  async function fetchCsvFor(sheet) {
    if (sheet.gid) return fetchSheetCsv({ spreadsheetId, gid: sheet.gid });
    return fetchSheetCsvByName(spreadsheetId, sheet.week);
  }

  async function syncAll({ refreshSheets = false } = {}) {
    if (state.syncing) return { skipped: true, reason: "Đang đồng bộ, vui lòng đợi." };
    state.syncing = true;
    try {
      const sheets = await resolveSheets({ force: refreshSheets });
      const result = await syncAllWeeks(db, {
        sheets,
        fetchCsv: fetchCsvFn || fetchCsvFor,
        discoveryMethod: state.discoveryMethod,
      });
      return { synced: true, discoveryMethod: state.discoveryMethod, ...result };
    } finally {
      state.syncing = false;
    }
  }

  function syncSummary() {
    const rows = getSyncState(db);
    const ok = rows.filter((r) => r.last_status === "OK").length;
    const failed = rows.filter((r) => r.last_status === "ERROR").length;
    const maxRow = db.prepare(`SELECT MAX(last_sync_at) AS lastSyncAt FROM sync_state`).get();
    return {
      lastSyncAt: (maxRow && maxRow.lastSyncAt) || null,
      status: rows.length === 0 ? "never" : failed === 0 ? "success" : ok === 0 ? "error" : "partial",
      worksheets: getDiscoveredSheets(db).length,
      sessions: countActiveSessions(db),
    };
  }

  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendError(res, code, message) {
    send(res, code, { error: { message } });
  }

  function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          const e = new Error("Request body quá lớn.");
          e.statusCode = 413;
          reject(e);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          const e = new Error("Body không phải JSON hợp lệ.");
          e.statusCode = 400;
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  function clientIdOf(req, url, body) {
    return (
      req.headers["x-client-id"] || body?.clientId || url.searchParams.get("clientId") || ""
    );
  }

  function serializeSession(r) {
    return serializeSessionRow(r, todayISO());
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      // ----- static -----
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return serveFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/styles.css") {
        return serveFile(res, path.join(PUBLIC, "styles.css"), "text/css; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/app.js") {
        return serveFile(res, path.join(PUBLIC, "app.js"), "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/api/status") {
        return send(res, 200, { sync: getSyncState(db), today: todayISO(), summary: syncSummary() });
      }
      if (req.method === "GET" && pathname === "/api/sync/status") {
        return send(res, 200, syncSummary());
      }

      // ----- subscriptions -----
      if (pathname === "/api/subscriptions" && req.method === "GET") {
        const cid = validateClientId(clientIdOf(req, url, null));
        if (!cid.ok) return sendError(res, 400, cid.error);
        const subs = listSubscriptions(db, cid.value).map((s) => ({
          id: s.id,
          courseCode: s.course_code,
          groupCode: s.group_code,
          notificationEnabled: !!s.notification_enabled,
          createdAt: s.created_at,
        }));
        return send(res, 200, { subscriptions: subs });
      }

      if (pathname === "/api/subscriptions" && req.method === "POST") {
        const body = await readBody(req);
        const cid = validateClientId(clientIdOf(req, url, body));
        if (!cid.ok) return sendError(res, 400, cid.error);
        // Accept fused input in the course field: "CT31201" -> CT312 + 01,
        // "CT005 - D04" -> CT005 + D04. An explicit group field wins on conflict.
        const pre = splitCourseGroup(body.courseCode || "");
        if (!pre.courseCode) return sendError(res, 400, "Mã môn không được để trống. Ví dụ: CT005");
        let cc;
        let gc;
        if (pre.groupCode) {
          cc = validateCourseCode(pre.courseCode);
          if (!cc.ok) return sendError(res, 400, cc.error);
          const explicitGroup = String(body.groupCode || "").trim();
          gc = explicitGroup ? validateGroupCode(explicitGroup) : validateGroupCode(pre.groupCode);
          if (!gc.ok) return sendError(res, 400, gc.error);
        } else {
          cc = validateCourseCode(body.courseCode);
          if (!cc.ok) return sendError(res, 400, cc.error);
          gc = validateGroupCode(body.groupCode);
          if (!gc.ok) return sendError(res, 400, gc.error);
        }
        const { subscription, created } = createSubscription(db, {
          clientId: cid.value,
          courseCode: cc.value,
          groupCode: gc.value,
        });
        const { upcoming, past } = queryScheduleWindow(db, [
          { course_code: cc.value, group_code: gc.value, id: subscription.id },
        ]);
        return send(res, created ? 201 : 200, {
          subscription: {
            id: subscription.id,
            courseCode: subscription.course_code,
            groupCode: subscription.group_code,
          },
          created,
          matches: upcoming.map(serializeSession),
          recentPast: past.map(serializeSession),
        });
      }

      const delMatch = pathname.match(/^\/api\/subscriptions\/(\d+)$/);
      if (delMatch && req.method === "DELETE") {
        const body = await readBody(req).catch(() => ({}));
        const cid = validateClientId(clientIdOf(req, url, body));
        if (!cid.ok) return sendError(res, 400, cid.error);
        const ok = deleteSubscription(db, cid.value, Number(delMatch[1]));
        if (!ok) return sendError(res, 404, "Không tìm thấy môn đang theo dõi.");
        return send(res, 200, { deleted: true });
      }

      // ----- schedules (scoped to caller's subscriptions) -----
      if (pathname === "/api/schedules" && req.method === "GET") {
        const cid = validateClientId(clientIdOf(req, url, null));
        if (!cid.ok) return sendError(res, 400, cid.error);
        const subs = listSubscriptions(db, cid.value);
        const { upcoming, past } = queryScheduleWindow(db, subs);
        return send(res, 200, {
          today: todayISO(),
          sessions: upcoming.map(serializeSession),
          recentPast: past.map(serializeSession),
        });
      }

      // ----- single nearest reminder (backend decides, exactly 0 or 1) -----
      if (pathname === "/api/reminder" && req.method === "GET") {
        const cid = validateClientId(clientIdOf(req, url, null));
        if (!cid.ok) return sendError(res, 400, cid.error);
        const found = getNearestReminder(db, cid.value);
        if (!found) return send(res, 200, { reminder: null });
        const session = serializeSession({ ...found.session, subscription_id: found.subscription.id });
        for (const k of Object.keys(session)) {
          if (session[k] === null || session[k] === undefined) delete session[k];
        }
        return send(res, 200, {
          reminder: {
            subscription: {
              id: found.subscription.id,
              courseCode: found.subscription.course_code,
              groupCode: found.subscription.group_code,
            },
            session,
            isToday: session.status === "TODAY",
          },
        });
      }

      // ----- notifications -----
      if (pathname === "/api/notifications" && req.method === "GET") {
        const cid = validateClientId(clientIdOf(req, url, null));
        if (!cid.ok) return sendError(res, 400, cid.error);
        const items = listNotifications(db, cid.value).map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          date: n.session_date || n.scheduled_for,
          slot: n.session_slot,
          room: n.session_room,
          courseName: n.session_course_name || null,
          status: n.status,
          createdAt: n.created_at,
        }));
        return send(res, 200, { notifications: items });
      }

      // ----- manual sync (rate-limited) -----
      if (pathname === "/api/sync" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const now = Date.now();
        if (now - state.lastManualSyncAt < 60_000) {
          return sendError(res, 429, "Vừa đồng bộ xong. Vui lòng đợi ít nhất 1 phút.");
        }
        state.lastManualSyncAt = now;
        const result = await syncAll({ refreshSheets: !!(body && body.refreshSheets) });
        if (result.skipped) return send(res, 200, result);
        const failed = (result.weeks || []).filter((w) => w.status === "FAILED");
        if (failed.length > 0 && failed.length === (result.weeks || []).length && (result.weeks || []).length > 0) {
          return send(res, 502, { ...result, message: "Không lấy được lịch từ Google Sheet. Dữ liệu cũ vẫn được giữ. Thử lại sau." });
        }
        return send(res, 200, { ...result, summary: syncSummary() });
      }

      return sendError(res, 404, "Không tìm thấy.");
    } catch (e) {
      // Never leak stack traces to clients; log server-side instead.
      console.error("request failed:", (e && e.message) || e);
      if (e && e.statusCode && e.statusCode < 500) {
        return sendError(res, e.statusCode, e.message);
      }
      return sendError(res, 500, "Có lỗi xảy ra. Vui lòng thử lại.");
    }
  });

  return { server, db, syncAll };
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Không tìm thấy." } }));
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length });
    res.end(data);
  });
}

// Run directly: `node src/server.js`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const dbPath = process.env.DB_PATH || path.join(ROOT, "data", "app.db");
  const spreadsheetId = process.env.SPREADSHEET_ID || SPREADSHEET_ID;
  const sources = parseSheetSources(process.env.SHEET_SOURCES || DEFAULT_SOURCES);
  const intervalMin = Number(process.env.SYNC_INTERVAL_MIN || 30);
  const discoveryTtlMin = Number(process.env.DISCOVERY_TTL_MIN || 360);

  const { server, syncAll } = createApp({ dbPath, spreadsheetId, sources, discoveryTtlMin });
  server.listen(port, () => {
    console.log(`CTU Practice Reminder running on http://localhost:${port}`);
  });
  // Initial sync in background; UI shows state via /api/status.
  syncAll({ refreshSheets: true })
    .then((r) => console.log("Initial sync:", JSON.stringify(r.totals || r)))
    .catch((e) => console.error("Initial sync failed:", e.message));
  if (intervalMin > 0) {
    setInterval(() => {
      syncAll().catch((e) => console.error("Scheduled sync failed:", e.message));
    }, intervalMin * 60_000);
  }
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, createSubscription, listNotifications, getSyncState, listChangesForSession, getSessionByIdentity, insertSession, addNotification } from "../src/db.js";
import { syncWeek, migrateFusedGroups, formatOptional, courseHeadline, sessionCardLines, repairLegacyNotifications } from "../src/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T01 = fs.readFileSync(path.join(__dirname, "fixtures", "t01.csv"), "utf8");

const MINI = [
  "Buổi,Phòng,Thứ 2,Thứ 3",
  ",,07/09/2026,08/09/2026",
  'SÁNG,P104 (P06 cũ),,"CT005-D04 - NT CNS\nThầy BVQ Bảo"',
  'CHIỀU,P104 (P06 cũ),"CT10101 - LTCB\nCô TTT Tuyền",',
].join("\n");

const MINI_MOVED = [
  "Buổi,Phòng,Thứ 2,Thứ 3",
  ",,07/09/2026,08/09/2026",
  'SÁNG,P203 (P23 cũ),,"CT005-D04 - NT CNS\nThầy BVQ Bảo"',
  'CHIỀU,P104 (P06 cũ),"CT10101 - LTCB\nCô TTT Tuyền",',
].join("\n");

const MINI_REMOVED = [
  "Buổi,Phòng,Thứ 2,Thứ 3",
  ",,07/09/2026,08/09/2026",
  "SÁNG,P104 (P06 cũ),,",
  'CHIỀU,P104 (P06 cũ),"CT10101 - LTCB\nCô TTT Tuyền",',
].join("\n");

describe("sync + change detection", () => {
  it("syncs real T01 fixture and is idempotent", async () => {
    const db = openDatabase(":memory:");
    const first = await syncWeek(db, { week: "T01", sourceGid: "gid-t01", csvText: T01, today: "2026-09-01" });
    assert.ok(first.total > 50, `expected dozens, got ${first.total}`);
    assert.ok(first.added > 0);
    const second = await syncWeek(db, { week: "T01", sourceGid: "gid-t01", csvText: T01, today: "2026-09-01" });
    assert.equal(second.added, 0);
    assert.equal(second.changed, 0);
    assert.equal(second.removed, 0);
    const state = getSyncState(db);
    assert.equal(state.length, 1);
    assert.equal(state[0].last_status, "OK");
  });

  it("detects a room change and notifies with old → new", async () => {
    const db = openDatabase(":memory:");
    createSubscription(db, { clientId: "stu-0001", courseCode: "CT005", groupCode: "D04" });
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: MINI, today: "2026-09-01" });
    const r = await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: MINI_MOVED, today: "2026-09-01" });
    assert.equal(r.added, 0);
    assert.equal(r.changed, 1);
    assert.equal(r.removed, 0);
    const row = getSessionByIdentity(db, "g1|2026-09-08|MORNING|CT005|D04");
    assert.equal(row.room, "P203 (P23 cũ)");
    const changes = listChangesForSession(db, row.id);
    assert.ok(changes.some((c) => c.field === "room"));
    const notifs = listNotifications(db, "stu-0001");
    const changed = notifs.find((n) => n.type === "SCHEDULE_CHANGED");
    assert.ok(changed);
    assert.ok(changed.body.includes("P104") && changed.body.includes("P203"));
  });

  it("detects removed sessions and notifies", async () => {
    const db = openDatabase(":memory:");
    createSubscription(db, { clientId: "stu-0002", courseCode: "CT005", groupCode: "D04" });
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: MINI, today: "2026-09-01" });
    const r = await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: MINI_REMOVED, today: "2026-09-01" });
    assert.equal(r.removed, 1);
    const row = getSessionByIdentity(db, "g1|2026-09-08|MORNING|CT005|D04");
    assert.equal(row.active, 0);
    const notifs = listNotifications(db, "stu-0002");
    assert.ok(notifs.some((n) => n.type === "SCHEDULE_REMOVED"));
  });

  it("records sync errors without crashing", async () => {
    const db = openDatabase(":memory:");
    await assert.rejects(() =>
      syncWeek(db, {
        week: "T01", sourceGid: "bad", spreadsheetId: "X",
        fetchFn: async () => ({ ok: false, status: 403 }),
      })
    );
  });

  it("sync architecture is not hard-coded to T01", async () => {
    const db = openDatabase(":memory:");
    const r = await syncWeek(db, { week: "T02", sourceGid: "gid-other", csvText: MINI, today: "2026-09-01" });
    assert.equal(r.week, "T02");
    assert.equal(r.total, 2);
    const row = getSessionByIdentity(db, "gid-other|2026-09-08|MORNING|CT005|D04");
    assert.equal(row.week, "T02");
  });

  it("migrates fused rows to split course/group without losing data", () => {
    const db = openDatabase(":memory:");
    insertSession(db, {
      identityKey: "g|2026-09-08|MORNING|CT31201|nogroup",
      week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
      room: "P105", courseCode: "CT31201", groupCode: null,
      courseRaw: "CT31201", titleRaw: "Khai khoán dữ liệu", teacherRaw: "Thầy LT Đạo",
      cellRaw: "CT31201 - Khai khoán dữ liệu\nThầy LT Đạo", sourceGid: "g",
    });
    insertSession(db, {
      identityKey: "g|2026-09-08|MORNING|CT106HM01|nogroup",
      week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
      room: "P106", courseCode: "CT106HM01", groupCode: null,
      courseRaw: "CT106HM01", titleRaw: "Mạng máy tính", teacherRaw: null,
      cellRaw: "CT106HM01 - Mạng máy tính", sourceGid: "g",
    });
    const r = migrateFusedGroups(db);
    assert.equal(r.migrated, 1);
    const moved = getSessionByIdentity(db, "g|2026-09-08|MORNING|CT312|01");
    assert.ok(moved);
    assert.equal(moved.title_raw, "Khai khoán dữ liệu");
    assert.equal(getSessionByIdentity(db, "g|2026-09-08|MORNING|CT31201|nogroup"), null);
    // Untouched: letter-infix codes are not fused.
    assert.ok(getSessionByIdentity(db, "g|2026-09-08|MORNING|CT106HM01|nogroup"));
    // Idempotent second run.
    assert.deepEqual(migrateFusedGroups(db), { migrated: 0, merged: 0 });
  });

  it("preserves room suffixes so parallel rooms are not lost", () => {
    const db = openDatabase(":memory:");
    for (const [key, room] of [
      ["g|2026-09-08|MORNING|CT31201|nogroup", "P104"],
      ["g|2026-09-08|MORNING|CT31201|nogroup|P105", "P105"],
    ]) {
      insertSession(db, {
        identityKey: key,
        week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
        room, courseCode: "CT31201", groupCode: null,
        courseRaw: "CT31201", titleRaw: "X", teacherRaw: null,
        cellRaw: "CT31201", sourceGid: "g",
      });
    }
    const r = migrateFusedGroups(db);
    assert.equal(r.migrated, 2);
    assert.equal(r.merged, 0);
    assert.equal(getSessionByIdentity(db, "g|2026-09-08|MORNING|CT312|01").room, "P104");
    assert.equal(getSessionByIdentity(db, "g|2026-09-08|MORNING|CT312|01|P105").room, "P105");
  });

  it("merges on identity collision instead of duplicating", () => {
    const db = openDatabase(":memory:");
    insertSession(db, {
      identityKey: "g|2026-09-08|MORNING|CT312|01",
      week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
      room: "P105", courseCode: "CT312", groupCode: "01",
      courseRaw: "CT312-01", titleRaw: "Khai khoán dữ liệu", teacherRaw: null,
      cellRaw: "CT312-01", sourceGid: "g",
    });
    insertSession(db, {
      identityKey: "g|2026-09-08|MORNING|CT31201|nogroup",
      week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
      room: "P105", courseCode: "CT31201", groupCode: null,
      courseRaw: "CT31201", titleRaw: "Khai khoán dữ liệu", teacherRaw: null,
      cellRaw: "CT31201", sourceGid: "g",
    });
    const r = migrateFusedGroups(db);
    assert.equal(r.merged, 1);
    assert.equal(r.migrated, 0);
    const loser = getSessionByIdentity(db, "g|2026-09-08|MORNING|CT31201|nogroup");
    assert.equal(loser.active, 0);
    assert.equal(getSessionByIdentity(db, "g|2026-09-08|MORNING|CT312|01").active, 1);
  });
});

describe("legacy notification repair", () => {
  function seedSession(db, overrides = {}) {
    return insertSession(db, {
      identityKey: "g|2026-09-08|MORNING|CT312|01",
      week: "T01", date: "2026-09-08", weekday: "Thứ 3", slot: "MORNING",
      room: "P105", courseCode: "CT312", groupCode: "01",
      courseRaw: "CT312-01", titleRaw: "Khai khoán dữ liệu", teacherRaw: "Thầy LT Đạo",
      cellRaw: "CT312-01", sourceGid: "g",
      ...overrides,
    });
  }

  it("rebuilds stale CT312-null rows without null text", () => {
    const db = openDatabase(":memory:");
    const { subscription } = createSubscription(db, { clientId: "rep-1", courseCode: "CT312", groupCode: "01" });
    const sid = seedSession(db);
    const nid = addNotification(db, {
      subscriptionId: subscription.id, sessionId: sid,
      type: "NEW_SESSION", title: "Lịch mới: CT312-null", body: "2026-09-08 (Thứ 3) — Sáng — P105.",
      scheduledFor: "2026-09-08",
    });
    const r = repairLegacyNotifications(db);
    assert.equal(r.repaired, 1);
    assert.equal(r.retired, 0);
    const fixed = listNotifications(db, "rep-1").find((n) => n.id === nid);
    assert.ok(fixed);
    assert.ok(!fixed.title.includes("null") && !fixed.body.includes("null"));
    assert.ok(fixed.title.includes("CT312") && fixed.title.includes("01"));
    // Second run is a no-op.
    assert.deepEqual(repairLegacyNotifications(db), { repaired: 0, retired: 0 });
  });

  it("retires rows whose session is gone", () => {
    const db = openDatabase(":memory:");
    const { subscription } = createSubscription(db, { clientId: "rep-2", courseCode: "CT312", groupCode: "01" });
    addNotification(db, {
      subscriptionId: subscription.id, sessionId: 9999,
      type: "NEW_SESSION", title: "Lịch mới: CT312-null", body: "x",
      scheduledFor: "2026-09-08",
    });
    const r = repairLegacyNotifications(db);
    assert.equal(r.retired, 1);
    assert.equal(listNotifications(db, "rep-2").length, 0);
  });
});

describe("display helpers (never render null)", () => {  it("formatOptional blanks empty values", async () => {
    const { formatOptional: f } = await import("../src/sync.js");
    assert.equal(f(null), null);
    assert.equal(f("  "), null);
    assert.equal(f(" P105 "), "P105");
  });

  it("courseHeadline prefers the source course name, falls back cleanly", () => {
    assert.equal(
      courseHeadline({ courseCode: "CT005", groupCode: "D04", titleRaw: "NT CNS" }),
      "CT005 - NT CNS"
    );
    assert.equal(courseHeadline({ course_code: "CT312", group_code: "01", title_raw: null }), "CT312");
  });

  it("sessionCardLines skips missing fields without null text", () => {
    const full = sessionCardLines({
      courseCode: "CT005", groupCode: "D04", titleRaw: "NT CNS",
      weekday: "Thứ 3", slot: "MORNING", room: "P104", teacherRaw: "Thầy BVQ Bảo",
    });
    assert.deepEqual(full, ["CT005 - NT CNS", "Nhóm D04", "Thứ 3 · Sáng", "Phòng P104", "Thầy BVQ Bảo"]);
    const bare = sessionCardLines({
      courseCode: "CT312", groupCode: "01", titleRaw: null,
      weekday: "Thứ 3", slot: "MORNING", room: "P105", teacherRaw: null,
    });
    assert.deepEqual(bare, ["CT312", "Nhóm 01", "Thứ 3 · Sáng", "Phòng P105"]);
    assert.ok(!bare.join("\n").includes("null"));
  });
});

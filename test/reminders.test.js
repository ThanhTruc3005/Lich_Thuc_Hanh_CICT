import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, createSubscription, listNotifications, addNotification } from "../src/db.js";
import { syncWeek } from "../src/sync.js";
import {
  sessionStatus,
  relativeDayLabel,
  reminderText,
  todayISO,
  addDaysISO,
  formatDateDisplay,
} from "../src/reminders.js";

const MINI = [
  "Buổi,Phòng,Thứ 2,Thứ 3,Thứ 4",
  ",,07/09/2026,08/09/2026,09/09/2026",
  'SÁNG,P104 (P06 cũ),,"CT005-D04 - NT CNS\nThầy BVQ Bảo",',
  'CHIỀU,P203 (P23 cũ),,,"CT005-D04 - NT CNS\nThầy BVQ Bảo"',
].join("\n");

describe("reminders", () => {
  it("computes TODAY / UPCOMING / PAST without any clock time", () => {
    assert.equal(sessionStatus("2026-09-08", "2026-09-08"), "TODAY");
    assert.equal(sessionStatus("2026-09-09", "2026-09-08"), "UPCOMING");
    assert.equal(sessionStatus("2026-09-07", "2026-09-08"), "PAST");
    assert.equal(relativeDayLabel("2026-09-08", "2026-09-08"), "Hôm nay");
    assert.equal(relativeDayLabel("2026-09-09", "2026-09-08"), "Ngày mai");
  });

  it("reminder text uses date + slot only, never exact times", () => {
    const s = { course_code: "CT005", group_code: "D04", slot: "MORNING", room: "P104 (P06 cũ)", date: "2026-09-08" };
    const text = reminderText(s, "TOMORROW");
    assert.ok(text.includes("Ngày mai"));
    assert.ok(text.includes("CT005-D04"));
    assert.ok(text.includes("Sáng"));
    assert.ok(!/\b\d{1,2}:\d{2}\b/.test(text), "must not contain clock times");
    assert.ok(!/7h|7 giờ/i.test(text));
  });

  it("creates exactly ONE nearest reminder: today morning wins over afternoon and future", async () => {
    const db = openDatabase(":memory:");
    createSubscription(db, { clientId: "rem-0001", courseCode: "CT005", groupCode: "D04" });
    const csv = [
      "Buổi,Phòng,Thứ 2,Thứ 3,Thứ 4,Thứ 5",
      ",,07/09/2026,08/09/2026,09/09/2026,10/09/2026",
      'SÁNG,P104,,"CT005-D04 - NT CNS\nThầy BVQ Bảo",,',
      'CHIỀU,P104,,"CT005-D04 - NT CNS\nThầy BVQ Bảo",,',
    ].join("\n");
    // today = 08/09 has both MORNING and AFTERNOON: only the morning is reminded.
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: csv, today: "2026-09-08" });
    let rows = listNotifications(db, "rem-0001").filter((n) => n.type === "NEAREST");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "🔔 Lịch học hôm nay");
    assert.ok(rows[0].body.includes("08/09") || rows[0].body.includes("Sáng"));
    assert.ok(!rows[0].body.includes("null"));
    // Re-sync stays at exactly one reminder (idempotent, never the far future).
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: csv, today: "2026-09-08" });
    rows = listNotifications(db, "rem-0001").filter((n) => n.type === "NEAREST");
    assert.equal(rows.length, 1);
  });

  it("picks the nearest future session when today has none", async () => {
    const db = openDatabase(":memory:");
    createSubscription(db, { clientId: "rem-0002", courseCode: "CT005", groupCode: "D04" });
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: MINI, today: "2026-09-07" });
    const rows = listNotifications(db, "rem-0002").filter((n) => n.type === "NEAREST");
    assert.equal(rows.length, 1); // not one per future session
    assert.equal(rows[0].title, "🔔 Lịch học gần nhất");
    assert.equal(rows[0].scheduled_for, "2026-09-08");
  });

  it("retires legacy bulk UPCOMING rows and skips missing names without null", async () => {
    const db = openDatabase(":memory:");
    const { subscription } = createSubscription(db, { clientId: "rem-0003", courseCode: "CT312", groupCode: "01" });
    addNotification(db, {
      subscriptionId: subscription.id, sessionId: 0,
      type: "UPCOMING", title: "old", body: "old", scheduledFor: "2026-09-08",
    });
    const csv = [
      "Buổi,Phòng,Thứ 3",
      ",,08/09/2026",
      'SÁNG,P105,"CT31201"',
    ].join("\n");
    await syncWeek(db, { week: "T01", sourceGid: "g1", csvText: csv, today: "2026-09-08" });
    const all = listNotifications(db, "rem-0003");
    assert.ok(all.filter((n) => n.type === "UPCOMING" && n.status === "PENDING").length === 0);
    const nearest = all.find((n) => n.type === "NEAREST");
    assert.ok(nearest);
    assert.ok(!nearest.body.includes("null") && !nearest.body.includes("undefined"));
    assert.ok(nearest.body.includes("CT312"));
    assert.ok(nearest.body.includes("Nhóm 01"));
  });

  it("date helpers behave", () => {
    assert.equal(formatDateDisplay("2026-09-08"), "08/09/2026");
    assert.equal(addDaysISO("2026-09-08", 1), "2026-09-09");
    assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

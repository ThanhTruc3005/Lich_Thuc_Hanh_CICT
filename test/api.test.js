import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, serializeSessionRow, queryScheduleWindow } from "../src/server.js";
import { insertSession } from "../src/db.js";
import { todayISO, addDaysISO } from "../src/reminders.js";

const ALICE = "alice-test-0001";
const BOB = "bob-test-0002";

let base;
let app;

function seedSession(session) {
  insertSession(app.db, {
    identityKey: session.identityKey,
    week: "T01",
    date: session.date,
    weekday: session.weekday || "Thứ 3",
    slot: session.slot || "MORNING",
    room: session.room || "P104 (P06 cũ)",
    courseCode: session.courseCode,
    groupCode: session.groupCode,
    courseRaw: ("courseRaw" in session) ? session.courseRaw : `${session.courseCode}-${session.groupCode}`,
    titleRaw: ("titleRaw" in session) ? session.titleRaw : "NT CNS",
    teacherRaw: ("teacherRaw" in session) ? session.teacherRaw : "Thầy BVQ Bảo",
    cellRaw: session.cellRaw || "raw",
    sourceGid: "g-test",
  });
}

async function api(path, { method = "GET", client = ALICE, body = null } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Client-Id": client },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  app = createApp({
    dbPath: ":memory:",
    sources: [],
    discoverFn: async () => ({ sheets: [], method: "test" }),
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  base = `http://localhost:${app.server.address().port}`;
  const today = todayISO();
  seedSession({
    identityKey: "g|tomorrow|MORNING|CT005|D04", date: addDaysISO(today, 1),
    courseCode: "CT005", groupCode: "D04",
  });
  seedSession({
    identityKey: "g|past|MORNING|CT005|D04", date: addDaysISO(today, -2),
    courseCode: "CT005", groupCode: "D04",
  });
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
});

describe("api", () => {
  it("full flow: subscribe -> appears -> sessions shown -> delete", async () => {
    const created = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "ct005", groupCode: "d04" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.subscription.courseCode, "CT005");
    assert.equal(created.data.matches.length, 1); // tomorrow session

    const dup = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "CT005", groupCode: "D04" },
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.data.created, false);

    const list = await api("/api/subscriptions");
    assert.equal(list.data.subscriptions.length, 1);

    const sched = await api("/api/schedules");
    assert.equal(sched.data.sessions.length, 1);
    assert.equal(sched.data.sessions[0].status, "UPCOMING");
    assert.equal(sched.data.recentPast.length, 1);
    assert.equal(sched.data.recentPast[0].status, "PAST");
    const s = sched.data.sessions[0];
    assert.match(s.slotLabel, /^(Sáng|Chiều)$/);
    assert.ok(s.dateDisplay && s.weekday && s.room && s.teacher);

    const del = await api(`/api/subscriptions/${list.data.subscriptions[0].id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const afterDel = await api("/api/subscriptions");
    assert.equal(afterDel.data.subscriptions.length, 0);
  });

  it("validates input and isolates clients", async () => {
    const bad = await api("/api/subscriptions", { method: "POST", body: { courseCode: "???", groupCode: "D04" } });
    assert.equal(bad.status, 400);
    const noClient = await fetch(`${base}/api/subscriptions`).then((r) => r.status);
    assert.equal(noClient, 400);

    const mine = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "CT005", groupCode: "D02" },
    });
    assert.equal(mine.status, 201);
    const bobList = await api("/api/subscriptions", { client: BOB });
    assert.equal(bobList.data.subscriptions.length, 0);
    const bobSched = await api("/api/schedules", { client: BOB });
    assert.equal(bobSched.data.sessions.length, 0);
    const bobDel = await api(`/api/subscriptions/${mine.data.subscription.id}`, {
      method: "DELETE", client: BOB,
    });
    assert.equal(bobDel.status, 404);
    await api(`/api/subscriptions/${mine.data.subscription.id}`, { method: "DELETE" });
  });

  it("accepts fused course input and returns courseName", async () => {
    const fused = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "CT31201", groupCode: "" },
    });
    assert.equal(fused.status, 201);
    assert.equal(fused.data.subscription.courseCode, "CT312");
    assert.equal(fused.data.subscription.groupCode, "01");
    const dashed = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "CT005 - D04", groupCode: "" },
    });
    assert.equal(dashed.status, 201);
    assert.equal(dashed.data.subscription.courseCode, "CT005");
    const sched = await api("/api/schedules");
    const hit = sched.data.sessions.find((s) => s.courseCode === "CT005");
    assert.ok(hit);
    assert.equal(hit.courseName, "NT CNS");
    await api(`/api/subscriptions/${fused.data.subscription.id}`, { method: "DELETE" });
    await api(`/api/subscriptions/${dashed.data.subscription.id}`, { method: "DELETE" });
  });

  it("rejects null-group subscriptions at the API boundary", async () => {
    const r = await api("/api/subscriptions", {
      method: "POST", body: { courseCode: "CT312", groupCode: "" },
    });
    assert.equal(r.status, 400);
  });

  it("/api/reminder returns exactly the nearest session", async () => {
    const today = todayISO();
    const client = "rem-api-0001";
    await api("/api/subscriptions", { method: "POST", client, body: { courseCode: "CT900", groupCode: "G1" } });
    for (const [key, date, slot] of [
      ["r3a", addDaysISO(today, 9), "AFTERNOON"],
      ["r3b", addDaysISO(today, 3), "AFTERNOON"],
      ["r3c", addDaysISO(today, 5), "MORNING"],
    ]) {
      seedSession({ identityKey: key, date, slot, courseCode: "CT900", groupCode: "G1", titleRaw: "Môn R3" });
    }
    const r = await api("/api/reminder", { client });
    assert.ok(r.data.reminder, "expected one reminder");
    assert.equal(r.data.reminder.session.date, addDaysISO(today, 3));
    assert.equal(r.data.reminder.session.courseName, "Môn R3");
    assert.ok(!JSON.stringify(r.data.reminder).includes("null-null"));
  });

  it("/api/reminder prefers today and omits missing names", async () => {
    const today = todayISO();
    const client = "rem-api-0002";
    await api("/api/subscriptions", { method: "POST", client, body: { courseCode: "CT901", groupCode: "G1" } });
    seedSession({ identityKey: "r4t", date: addDaysISO(today, 1), slot: "MORNING", courseCode: "CT901", groupCode: "G1", titleRaw: "Có tên" });
    seedSession({ identityKey: "r4d", date: today, slot: "AFTERNOON", courseCode: "CT901", groupCode: "G1", titleRaw: null, teacherRaw: null });
    const r = await api("/api/reminder", { client });
    assert.equal(r.data.reminder.session.date, today);
    assert.equal(r.data.reminder.isToday, true);
    assert.ok(!("courseName" in r.data.reminder.session), "missing names are omitted, never null");
    assert.ok(!("teacher" in r.data.reminder.session));
    assert.equal(r.data.reminder.session.groupCode, "G1");
  });

  it("/api/reminder is null when nothing is upcoming", async () => {
    const r = await api("/api/reminder", { client: "nobody-0000" });
    assert.equal(r.data.reminder, null);
  });

  it("manual sync is rate-limited", async () => {
    const first = await api("/api/sync", { method: "POST" });
    assert.equal(first.status, 200); // no sources configured -> instant empty sync
    const second = await api("/api/sync", { method: "POST" });
    assert.equal(second.status, 429);
  });

  it("syncs name-shaped discovered sheets without gid (regression)", async () => {
    const app2 = createApp({
      dbPath: ":memory:",
      sources: [],
      discoverFn: async () => ({ sheets: [{ name: "T09", gid: null }], method: "test" }),
      fetchCsvFn: async () =>
        [
          "Buổi,Phòng,Thứ 2,Thứ 3",
          ",,07/09/2026,08/09/2026",
          'SÁNG,P104,,"CT005-D04 - NT CNS\nThầy BVQ Bảo"',
        ].join("\n"),
    });
    await new Promise((resolve) => app2.server.listen(0, resolve));
    try {
      const port = app2.server.address().port;
      const res = await fetch(`http://localhost:${port}/api/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Id": ALICE },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.weeks.length, 1);
      assert.equal(data.weeks[0].week, "T09");
      assert.equal(data.weeks[0].status, "OK");
      const st = await fetch(`http://localhost:${port}/api/sync/status`).then((r) => r.json());
      assert.equal(st.worksheets, 1);
      assert.equal(st.sessions, 1);
      assert.match(st.lastSyncAt, /^\d{4}-\d{2}-\d{2}T/, "lastSyncAt must be set after sync");
      assert.equal(st.status, "success");
    } finally {
      await new Promise((resolve) => app2.server.close(resolve));
    }
  });

  it("serialized sessions never contain clock times", () => {
    const { upcoming } = queryScheduleWindow(app.db, [
      { course_code: "CT005", group_code: "D04", id: 999 },
    ]);
    const blob = JSON.stringify(upcoming.map((r) => serializeSessionRow(r)));
    assert.ok(!/\b\d{1,2}:\d{2}\b/.test(blob.replace(/\d{4}-\d{2}-\d{2}/g, "")));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  insertSession,
  getSessionByIdentity,
  querySessionsForSubscriptions,
  addNotification,
  listNotifications,
  listChangesForSession,
} from "../src/db.js";

function memDb() {
  return openDatabase(":memory:");
}

function seedSession(db, overrides = {}) {
  return insertSession(db, {
    identityKey: "g|2026-09-08|MORNING|CT005|D04",
    week: "T01",
    date: "2026-09-08",
    weekday: "Thứ 3",
    slot: "MORNING",
    room: "P104 (P06 cũ)",
    courseCode: "CT005",
    groupCode: "D04",
    courseRaw: "CT005-D04",
    titleRaw: "NT CNS",
    teacherRaw: "Thầy BVQ Bảo",
    cellRaw: "CT005-D04 - NT CNS\nThầy BVQ Bảo",
    sourceGid: "g",
    ...overrides,
  });
}

describe("database + subscriptions", () => {
  it("creates, lists, and deletes subscriptions", () => {
    const db = memDb();
    const { subscription, created } = createSubscription(db, {
      clientId: "client-1", courseCode: "CT005", groupCode: "D04",
    });
    assert.equal(created, true);
    assert.equal(subscription.course_code, "CT005");
    assert.equal(listSubscriptions(db, "client-1").length, 1);
    assert.equal(deleteSubscription(db, "client-1", subscription.id), true);
    assert.equal(listSubscriptions(db, "client-1").length, 0);
  });

  it("prevents duplicate subscriptions", () => {
    const db = memDb();
    // Note: normalization (ct005 -> CT005) happens in validation/server layer;
    // the DB dedupes identical normalized keys.
    const first = createSubscription(db, { clientId: "c1", courseCode: "CT005", groupCode: "D04" });
    const second = createSubscription(db, { clientId: "c1", courseCode: "CT005", groupCode: "D04" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.subscription.id, first.subscription.id);
    assert.equal(listSubscriptions(db, "c1").length, 1);
  });

  it("isolates clients from each other", () => {
    const db = memDb();
    const a = createSubscription(db, { clientId: "alice-01", courseCode: "CT005", groupCode: "D04" });
    createSubscription(db, { clientId: "bob-0002", courseCode: "CT005", groupCode: "D04" });
    // Same course is fine for another client (different rows)...
    assert.equal(listSubscriptions(db, "alice-01").length, 1);
    assert.equal(listSubscriptions(db, "bob-0002").length, 1);
    // ...but alice cannot delete bob's subscription.
    const bobSub = listSubscriptions(db, "bob-0002")[0];
    assert.equal(deleteSubscription(db, "alice-01", bobSub.id), false);
    assert.equal(listSubscriptions(db, "bob-0002").length, 1);
    assert.equal(deleteSubscription(db, "alice-01", a.subscription.id), true);
  });

  it("session identity key prevents duplicates", () => {
    const db = memDb();
    const id1 = seedSession(db);
    const found = getSessionByIdentity(db, "g|2026-09-08|MORNING|CT005|D04");
    assert.equal(found.id, id1);
    assert.throws(() => seedSession(db)); // UNIQUE violation
  });

  it("queries schedules scoped to subscriptions", () => {
    const db = memDb();
    seedSession(db);
    seedSession(db, {
      identityKey: "g|2026-09-09|MORNING|CT188|D01",
      date: "2026-09-09", courseCode: "CT188", groupCode: "D01", courseRaw: "CT188-D01",
    });
    const subs = listSubscriptions(db, "ghost-99");
    assert.equal(subs.length, 0);
    const { subscription } = createSubscription(db, { clientId: "ghost-99", courseCode: "CT005", groupCode: "D04" });
    const rows = querySessionsForSubscriptions(db, [subscription], { fromDate: "2026-09-01" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].course_code, "CT005");
  });

  it("notifications dedupe and stay scoped to the owner", () => {
    const db = memDb();
    const { subscription } = createSubscription(db, { clientId: "carol-03", courseCode: "CT005", groupCode: "D04" });
    const sid = seedSession(db);
    const n1 = addNotification(db, {
      subscriptionId: subscription.id, sessionId: sid,
      type: "UPCOMING", title: "t", body: "b", scheduledFor: "2026-09-08",
    });
    const n2 = addNotification(db, {
      subscriptionId: subscription.id, sessionId: sid,
      type: "UPCOMING", title: "t", body: "b", scheduledFor: "2026-09-08",
    });
    assert.ok(n1);
    assert.equal(n2, null); // duplicate suppressed
    const mine = listNotifications(db, "carol-03");
    assert.equal(mine.length, 1);
    assert.equal(listNotifications(db, "stranger-4").length, 0);
    assert.equal(listChangesForSession(db, sid).length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionTab, addDaysISO } from "../src/reminders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

describe("dashboard ux", () => {
  it("has no change-log section", () => {
    assert.ok(!html.includes("Thay đổi lịch"));
    assert.ok(!html.includes("historySection"));
    assert.ok(!html.includes("historyList"));
    assert.ok(!js.includes("historySection"));
    assert.ok(!js.includes("renderHistory"));
  });

  it("has exactly the four filters in order, no Sap toi", () => {
    const chips = [...html.matchAll(/data-filter="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(chips, ["today", "tomorrow", "past", "all"]);
    assert.ok(html.includes("Ngày mai"));
    assert.ok(!html.includes("Sắp tới"));
    assert.ok(!js.includes('"soon"') && !js.includes("'soon'"));
  });

  it("tomorrow means strictly today+1", () => {
    const today = "2026-10-08";
    assert.equal(sessionTab("2026-10-08", today), "today");
    assert.equal(sessionTab("2026-10-09", today), "tomorrow");
    assert.equal(sessionTab("2026-10-10", today), "future");
    assert.equal(sessionTab("2026-10-11", today), "future");
    assert.equal(sessionTab("2026-10-07", today), "past");
    assert.equal(addDaysISO(today, 1), "2026-10-09");
  });

  it("empty states never show null/undefined", () => {
    assert.ok(js.includes("Ngày mai không có lịch học."));
    assert.ok(js.includes("Hôm nay không có lịch học."));
    assert.ok(js.includes("Chưa có lịch học sắp tới."));
    for (const bad of [">null<", "'null'", '"null"', "undefined"]) {
      assert.ok(!js.includes(bad), `frontend must not render ${bad}`);
      assert.ok(!html.includes(bad), `markup must not render ${bad}`);
    }
  });

  it("reminder section renders a single nearest session", () => {
    assert.ok(html.includes("notifySection"));
    assert.ok(js.includes("/api/reminder"));
    // No multi-day listing logic left in the reminder renderer.
    assert.ok(!js.includes("UPCOMING"));
  });
});

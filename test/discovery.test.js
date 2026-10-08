import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSheetsFromHtml,
  filterWeekSheets,
  probeWeekSheets,
  discoverSheets,
} from "../src/sheet/discovery.js";
import { gvizTableToCsv, unwrapGviz, fetchSheetCsvByName } from "../src/sheet/gviz.js";
import { openDatabase, getSessionByIdentity, adoptGid } from "../src/db.js";
import { syncAllWeeks, sheetKey } from "../src/sync.js";

// Synthetic HTML: plain tab captions + bootstrap pairs in both escaping
// variants + a caption-only tab. Pair lines use BS (backslash) concat.
const BS = String.fromCharCode(92);
const FAKE_HTML = [
  '<div class="goog-inline-block docs-sheet-tab-caption">T01</div>',
  '<div class="goog-inline-block docs-sheet-tab-caption">LichNghi</div>',
  '<div class="goog-inline-block docs-sheet-tab-caption">T99</div>',
  '[21350203,"[1,0,' + BS + '"111' + BS + '",[{' + BS + '"1' + BS + '":[[0,0,' + BS + '"T01' + BS + '"',
  '[21350203,"[2,0,' + BS + BS + '"222' + BS + BS + '",[{' + BS + BS + '"1' + BS + BS + '":[[0,0,' + BS + BS + '"T02' + BS + BS + '"',
].join("");

const MINI = (room) =>
  [
    "Buổi,Phòng,Thứ 2,Thứ 3",
    ",,07/09/2026,08/09/2026",
    `SÁNG,${room},,"CT005-D04 - NT CNS\nThầy BVQ Bảo"`,
  ].join("\n");

describe("discovery", () => {
  it("extracts names+gids from both escaping variants, caption-only gets null gid", () => {
    const sheets = extractSheetsFromHtml(FAKE_HTML);
    const byName = new Map(sheets.map((s) => [s.name, s.gid]));
    assert.equal(byName.get("T01"), "111");
    assert.equal(byName.get("T02"), "222");
    assert.equal(byName.get("T99"), null);
    assert.equal(byName.get("LichNghi"), null);
  });

  it("keeps only week-like tabs", () => {
    const weeks = filterWeekSheets(extractSheetsFromHtml(FAKE_HTML));
    assert.deepEqual(
      weeks.map((s) => s.name),
      ["T01", "T99", "T02"]
    );
  });

  it("falls back to probing when HTML has no sheets", async () => {
    const fetchFn = async (url) => {
      const hit = /sheet=(T00|T01)/.test(url);
      return {
        ok: true,
        text: async () =>
          hit
            ? 'google.visualization.Query.setResponse({"status":"ok","table":{"cols":[],"rows":[]}});'
            : 'google.visualization.Query.setResponse({"status":"error","errors":[{"detailed_message":"not found"}]});',
      };
    };
    const { sheets, method } = await discoverSheets("X", { fetchFn });
    assert.equal(method, "probe");
    assert.deepEqual(
      sheets.map((s) => s.name),
      ["T00", "T01"]
    );
  });

  it("probeWeekSheets stops after trailing misses", async () => {
    let calls = 0;
    const fetchFn = async (url) => {
      calls++;
      const hit = /sheet=T0[012]/.test(url);
      return {
        ok: true,
        text: async () =>
          `google.visualization.Query.setResponse({"status":"${hit ? "ok" : "error"}"${
            hit ? ',"table":{"cols":[],"rows":[]}' : ""
          }});`,
      };
    };
    const found = await probeWeekSheets("X", { fetchFn, maxWeek: 10, trailingMisses: 2 });
    assert.deepEqual(
      found.map((s) => s.name),
      ["T00", "T01", "T02"]
    );
    assert.ok(calls < 11, `should stop early, called ${calls}x`);
  });
});

describe("gviz", () => {
  it("converts tables to CSV preserving multiline cells, prefers formatted values", () => {
    const table = {
      cols: [{ label: "Buổi" }, { label: "Thứ 3" }, { label: "" }],
      rows: [
        { c: [{ v: "SÁNG" }, { v: "CT005-D04 - NT CNS\nThầy BVQ Bảo" }, null] },
        { c: [{ v: "X" }, { v: 'a"b,c' }, { v: 5 }] },
        { c: [{ v: "Date(2026,8,8)", f: "08/09/2026" }] },
      ],
    };
    const csv = gvizTableToCsv(table);
    assert.ok(csv.includes('"CT005-D04 - NT CNS\nThầy BVQ Bảo"'));
    assert.ok(csv.includes('"a""b,c"'));
    assert.ok(csv.includes("08/09/2026"));
    assert.ok(!csv.includes("Date(2026"));
  });

  it("rejects error payloads and bad wrappers", () => {
    assert.throws(() =>
      unwrapGviz('google.visualization.Query.setResponse({"status":"error"});')
    );
    assert.throws(() => unwrapGviz("not json at all"));
  });

  it("fetchSheetCsvByName uses the sheet name, no gid needed", async () => {
    let seenUrl = "";
    const fetchFn = async (url) => {
      seenUrl = url;
      return {
        ok: true,
        text: async () =>
          'google.visualization.Query.setResponse({"status":"ok","table":{"cols":[{"label":"Buổi"}],"rows":[]}});',
      };
    };
    const csv = await fetchSheetCsvByName("SID", "T05", { fetchFn });
    assert.ok(seenUrl.includes("sheet=T05"));
    assert.ok(csv.startsWith("Buổi"));
  });
});

describe("multi-week sync", () => {
  const sheets = [
    { week: "T01", gid: "g1" },
    { week: "T02", gid: null },
    { week: "T03", gid: "g3" },
  ];
  const fetchCsv = async (sheet) => {
    if (sheet.week === "T03") throw new Error("boom");
    if (sheet.week === "T02") return MINI("P203");
    return MINI("P104");
  };

  it("syncs all weeks, isolates one failure, stays idempotent", async () => {
    const db = openDatabase(":memory:");
    const logs = [];
    const first = await syncAllWeeks(db, { sheets, fetchCsv, today: "2026-09-01", logger: { log: (m) => logs.push(m) } });
    assert.equal(first.weeks.length, 3);
    assert.equal(first.weeks.find((w) => w.week === "T03").status, "FAILED");
    assert.equal(first.totals.added, 2);
    assert.equal(first.totals.unchanged, 0);
    assert.ok(logs.some((l) => l.startsWith("SYNC START")));
    assert.ok(logs.some((l) => l.includes("T03: FAILED")));
    assert.ok(logs.some((l) => l.startsWith("SYNC RESULT")));

    const second = await syncAllWeeks(db, { sheets, fetchCsv, today: "2026-09-01", logger: { log: () => {} } });
    assert.equal(second.totals.added, 0);
    assert.equal(second.totals.changed, 0);
    assert.equal(second.totals.removed, 0);
    assert.equal(second.totals.unchanged, 2);
  });

  it("keys name-fetched sheets stably and migrates to gid via adoptGid", async () => {
    const db = openDatabase(":memory:");
    await syncAllWeeks(db, {
      sheets: [{ week: "T02", gid: null }],
      fetchCsv: async () => MINI("P203"),
      today: "2026-09-01",
      logger: { log: () => {} },
    });
    assert.equal(sheetKey({ week: "T02", gid: null }), "name:T02");
    assert.ok(getSessionByIdentity(db, "name:T02|2026-09-08|MORNING|CT005|D04"));
    const moved = adoptGid(db, { week: "T02", gid: "g2" });
    assert.equal(moved, 1);
    assert.ok(getSessionByIdentity(db, "g2|2026-09-08|MORNING|CT005|D04"));
    // Re-syncing with the real gid does not duplicate.
    const r = await syncAllWeeks(db, {
      sheets: [{ week: "T02", gid: "g2" }],
      fetchCsv: async () => MINI("P203"),
      today: "2026-09-01",
      logger: { log: () => {} },
    });
    assert.equal(r.totals.added, 0);
  });
});

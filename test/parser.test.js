import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseCsv,
  parseDateCell,
  parseCourseLine,
  parseWeekCsv,
  normalizeCourseQuery,
  matchesSubscription,
  isTeacherLine,
} from "../src/sheet/parser.js";
import { fetchSheetCsv } from "../src/sheet/fetcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCsv = fs.readFileSync(path.join(__dirname, "fixtures", "t01.csv"), "utf8");

function sessionsFor(csv, week = "T01") {
  return parseWeekCsv(csv, { week });
}

// Minimal synthetic week CSV for deterministic unit tests.
const MINI_CSV = [
  ",TUẦN,1,07/09/2026,ĐẾN,13/09/2026,,,",
  "Buổi,Phòng,Thứ 2,Thứ 3,Thứ 4,Thứ 5,Thứ 6,Thứ 7,Chủ nhật",
  ",,07/09/2026,08/09/2026,09/09/2026,10/09/2026,11/09/2026,12/09/2026,13/09/2026",
  'SÁNG,P104 (P06 cũ),,"CT005-D04 - NT CNS\nThầy BVQ Bảo",,,,,',
  ',P105 (P07 cũ),,,,,,,',
  'CHIỀU,P104 (P06 cũ),"CT10101 - LTCB\nCô TTT Tuyền",,,,,,,',
].join("\n");

describe("core parser", () => {
  it("1. parses dates from the header row, not the sheet name", () => {
    const { sessions } = sessionsFor(MINI_CSV, "TX");
    assert.ok(sessions.length > 0);
    for (const s of sessions) assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
    const dates = new Set(sessions.map((s) => s.date));
    assert.ok(dates.has("2026-09-08"));
    assert.equal(parseDateCell("07/09/2026"), "2026-09-07");
  });

  it("2. parses MORNING via forward-fill", () => {
    const { sessions } = sessionsFor(MINI_CSV);
    const m = sessions.find((s) => s.room.startsWith("P104") && s.date === "2026-09-08");
    assert.ok(m);
    assert.equal(m.session, "MORNING");
  });

  it("3. parses AFTERNOON block", () => {
    const { sessions } = sessionsFor(MINI_CSV);
    const a = sessions.find((s) => s.session === "AFTERNOON");
    assert.ok(a);
    assert.equal(a.date, "2026-09-07");
  });

  it("4. keeps raw room", () => {
    const { sessions } = sessionsFor(MINI_CSV);
    assert.ok(sessions.some((s) => s.room === "P104 (P06 cũ)"));
  });

  it("5. parses CT005-D04 main case", () => {
    const { sessions } = sessionsFor(MINI_CSV);
    const s = sessions.find((x) => x.cellRaw.includes("CT005-D04"));
    assert.ok(s);
    assert.equal(s.courseCode, "CT005");
    assert.equal(s.groupCode, "D04");
    assert.equal(s.titleRaw, "NT CNS");
    assert.equal(s.teacherRaw, "Thầy BVQ Bảo");
  });

  it("6. parses teacher lines incl. missing-space typo", () => {
    assert.ok(isTeacherLine("Thầy BVQ Bảo"));
    assert.ok(isTeacherLine("Cô NTK Yên"));
    assert.ok(isTeacherLine("ThầyLHQ Bảo"));
    const p = parseCourseLine("Thầy BVQ Bảo");
    assert.equal(p, null); // teacher lines are not course lines
  });

  it("7. normalizes course/group query variants", () => {
    const variants = ["ct005", "ct005-d04", "CT005 - D04", "ct005 - d04", " CT005-D04 "];
    const normed = variants.map(normalizeCourseQuery);
    assert.deepEqual(normed[1], { courseCode: "CT005", groupCode: "D04" });
    assert.deepEqual(normed[2], { courseCode: "CT005", groupCode: "D04" });
    assert.deepEqual(normed[3], { courseCode: "CT005", groupCode: "D04" });
    const { sessions } = sessionsFor(MINI_CSV);
    const target = sessions.find((s) => s.courseCode === "CT005");
    for (const q of ["ct005-d04", "CT005 - D04", "ct005 - d04"]) {
      assert.ok(matchesSubscription(target, q), q);
    }
    // course-only query matches any group of that course
    assert.ok(matchesSubscription(target, "ct005"));
    // wrong group does not match
    assert.equal(matchesSubscription(target, "CT005-D99"), false);
  });

  it("8. skips empty cells silently", () => {
    const { sessions, warnings } = sessionsFor(MINI_CSV);
    // P105 row is fully empty -> no sessions for that room
    assert.equal(sessions.filter((s) => s.room.startsWith("P105")).length, 0);
    assert.ok(!warnings.some((w) => w.reason === "empty_csv"));
  });

  it("9. handles non-course events without crashing", () => {
    const csv = [
      "Buổi,Phòng,Thứ 2,Thứ 3",
      ",,07/09/2026,08/09/2026",
      'SÁNG,P108 (P10 cũ),,"Quản lý dự án (VLVH)\nThầy HQ Thái"',
    ].join("\n");
    const { sessions } = parseWeekCsv(csv, { week: "T01" });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].courseCode, null);
    assert.equal(sessions[0].groupCode, null);
    assert.equal(matchesSubscription(sessions[0], "CT005-D04"), false);
    assert.ok(sessions[0].cellRaw.length > 0);
  });

  it("10. handles multi-course cell without crashing and keeps raw", () => {
    const csv = [
      "Buổi,Phòng,Thứ 2,Thứ 3",
      ",,07/09/2026,08/09/2026",
      'SÁNG,P214 (P19 cũ),"CT177HM01 - CTDL\nCT177HM02 - CTDL\nCô PP Lan",',
    ].join("\n");
    const { sessions, warnings } = parseWeekCsv(csv, { week: "T01" });
    assert.ok(sessions.length >= 2);
    assert.ok(sessions.every((s) => s.cellRaw.includes("CT177HM01")));
    assert.ok(warnings.some((w) => w.reason === "multi_course_cell"));
    // Unknown-group tokens: group null, course kept, never invented
    assert.ok(sessions.every((s) => s.groupCode === null));
  });

  it("11. tolerates whitespace/case variants, never invents group", () => {
    assert.deepEqual(parseCourseLine("ct005 - d04 - NT CNS"), {
      courseCode: "CT005",
      groupCode: "D04",
      courseRaw: "ct005 - d04",
      titleRaw: "NT CNS",
    });
    assert.deepEqual(parseCourseLine("CT49501 - Dựng phim"), {
      courseCode: "CT495",
      groupCode: "01",
      courseRaw: "CT49501",
      titleRaw: "Dựng phim",
    });
    assert.deepEqual(parseCourseLine("CT106HM01 - Mạng máy tính"), {
      courseCode: "CT106HM01",
      groupCode: null,
      courseRaw: "CT106HM01",
      titleRaw: "Mạng máy tính",
    });
  });

  it("12. parses many rooms in one week (real T01 fixture)", () => {
    const { sessions } = sessionsFor(fixtureCsv, "T01");
    const rooms = new Set(sessions.map((s) => s.room));
    assert.ok(rooms.size >= 10, `expected many rooms, got ${rooms.size}`);
    assert.ok(sessions.length > 50, `expected dozens of sessions, got ${sessions.length}`);
  });

  it("13. days without data yield no sessions (real fixture spot-check)", () => {
    const { sessions } = sessionsFor(fixtureCsv, "T01");
    // P106 is fully empty in T01 across the week
    assert.equal(sessions.filter((s) => s.room.startsWith("P106")).length, 0);
    // CT005-D04 appears on specific days only
    const d04dates = new Set(
      sessions.filter((s) => s.courseCode === "CT005" && s.groupCode === "D04").map((s) => s.date)
    );
    assert.ok(d04dates.has("2026-09-08"));
    assert.ok(!d04dates.has("2026-09-07"));
  });

  it("14. never crashes on weird cells", () => {
    const csv = [
      "Buổi,Phòng,Thứ 2,Thứ 3",
      ",,07/09/2026,08/09/2026",
      'SÁNG,P1,"a,b ""quoted""\n\n\nCô  X",',
      ",P2,,",
      "CHIỀU,P3,\"   \",",
    ].join("\n");
    const { sessions } = parseWeekCsv(csv, { week: "T01" });
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.every((s) => typeof s.cellRaw === "string"));
  });

  it("real T01 fixture: key CT005-D04 session shape", () => {
    const { sessions } = sessionsFor(fixtureCsv, "T01");
    const hit = sessions.find(
      (s) =>
        s.courseCode === "CT005" &&
        s.groupCode === "D04" &&
        s.date === "2026-09-08" &&
        s.session === "MORNING"
    );
    assert.ok(hit, "expected CT005-D04 on 2026-09-08 MORNING");
    assert.equal(hit.teacherRaw, "Thầy BVQ Bảo");
    assert.ok(hit.room.startsWith("P104"));
    assert.equal(hit.week, "T01");
    assert.ok(hit.cellRaw.includes("CT005-D04"));
    assert.ok(hit.cellRaw.includes("\n"), "cellRaw must preserve line breaks for debug");
  });

  it("parseCsv handles quoted multiline cells", () => {
    const rows = parseCsv('a,"x\ny",c\n1,2,3');
    assert.equal(rows[0][1], "x\ny");
  });

  it("splits fused CT31201 into CT312 + 01", () => {
    assert.deepEqual(parseCourseLine("CT31201 - Khai khoán dữ liệu"), {
      courseCode: "CT312",
      groupCode: "01",
      courseRaw: "CT31201",
      titleRaw: "Khai khoán dữ liệu",
    });
    assert.deepEqual(parseCourseLine("CT312-01 - Khai khoán dữ liệu"), {
      courseCode: "CT312",
      groupCode: "01",
      courseRaw: "CT312 - 01",
      titleRaw: "Khai khoán dữ liệu",
    });
    assert.deepEqual(parseCourseLine("CT312 - 01 - Khai khoán dữ liệu"), {
      courseCode: "CT312",
      groupCode: "01",
      courseRaw: "CT312 - 01",
      titleRaw: "Khai khoán dữ liệu",
    });
  });

  it("keeps CT005-D04 and letter-infix codes intact", () => {
    assert.deepEqual(parseCourseLine("CT005-D04 - NT CNS"), {
      courseCode: "CT005",
      groupCode: "D04",
      courseRaw: "CT005 - D04",
      titleRaw: "NT CNS",
    });
    assert.equal(parseCourseLine("CT106HM01 - Mạng máy tính").groupCode, null);
    assert.equal(parseCourseLine("CT177HM01 - CTDL").groupCode, null);
    assert.equal(parseCourseLine("CT177HM02 - CTDL").groupCode, null);
    assert.equal(parseCourseLine("CT100D03 - Kỹ năng").groupCode, null);
  });

  it("keeps dashed-group tokens on the dashed branch (CT22301-QLDAPM)", () => {
    assert.deepEqual(parseCourseLine("CT22301- QLDAPM"), {
      courseCode: "CT22301",
      groupCode: "QLDAPM",
      courseRaw: "CT22301- QLDAPM",
      titleRaw: null,
    });
  });
});

describe("fetcher", () => {
  it("builds CSV, returns text, throws on HTTP error, retries bounded", async () => {
    let calls = 0;
    const okFetch = async () => ({ ok: true, text: async () => "a,b" });
    assert.equal(await fetchSheetCsv({ spreadsheetId: "X", gid: "1", fetchFn: okFetch }), "a,b");

    const failFetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(() => fetchSheetCsv({ spreadsheetId: "X", gid: "1", fetchFn: failFetch }));

    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return { ok: true, text: async () => "ok" };
    };
    assert.equal(
      await fetchSheetCsv({ spreadsheetId: "X", gid: "1", retries: 2, baseDelayMs: 1, fetchFn: flaky }),
      "ok"
    );
    assert.equal(calls, 2);

    await assert.rejects(() => fetchSheetCsv({ spreadsheetId: "", gid: "1", fetchFn: okFetch }));
  });
});

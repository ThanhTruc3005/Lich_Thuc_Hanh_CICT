import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCourseCode,
  validateGroupCode,
  validateClientId,
  normalizeCode,
  splitCourseGroup,
} from "../src/validation.js";

describe("validation", () => {
  it("accepts and normalizes valid codes", () => {
    assert.deepEqual(validateCourseCode("ct005"), { ok: true, value: "CT005" });
    assert.deepEqual(validateGroupCode(" d04 "), { ok: true, value: "D04" });
    assert.equal(normalizeCode(" ct005 "), "CT005");
  });
  it("rejects empty and malformed codes", () => {
    assert.equal(validateCourseCode("").ok, false);
    assert.equal(validateCourseCode("ABC").ok, false);
    assert.equal(validateCourseCode("CT005-D04").ok, false); // combined goes in one field
    assert.equal(validateGroupCode("").ok, false);
    assert.equal(validateGroupCode("D 04!!").ok, false);
  });
  it("never invents group rules for ambiguous tokens", () => {
    // Fused numeric suffix splits by the documented rule (CT31201 -> CT312 + 01).
    assert.deepEqual(splitCourseGroup("CT31201"), { courseCode: "CT312", groupCode: "01" });
    // Letter-infix codes stay whole: no fabricated split.
    assert.deepEqual(splitCourseGroup("CT106HM01"), { courseCode: "CT106HM01", groupCode: null });
    assert.deepEqual(splitCourseGroup("CT100D03"), { courseCode: "CT100D03", groupCode: null });
    assert.deepEqual(splitCourseGroup("ct005 - d04"), { courseCode: "CT005", groupCode: "D04" });
  });
  it("validates client ids", () => {
    assert.equal(validateClientId("").ok, false);
    assert.equal(validateClientId("abc").ok, false);
    assert.equal(validateClientId("550e8400-e29b-41d4-a716-446655440000").ok, true);
  });
});

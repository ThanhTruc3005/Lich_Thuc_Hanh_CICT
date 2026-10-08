// Input validation + normalization (MVP).
// Reuses parser rules: never invent group parsing for ambiguous codes.

import { normalizeCourseQuery } from "./sheet/parser.js";

const COURSE_RE = /^[A-Z]{2,4}\d{2,5}$/;
const GROUP_RE = /^[A-Z0-9]{1,10}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function normalizeCode(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function validateCourseCode(input) {
  const code = normalizeCode(input);
  if (!code) return { ok: false, error: "Mã môn không được để trống. Ví dụ: CT005" };
  if (!COURSE_RE.test(code)) {
    return { ok: false, error: `Mã môn "${String(input).trim()}" không hợp lệ. Ví dụ: CT005` };
  }
  return { ok: true, value: code };
}

export function validateGroupCode(input) {
  const group = normalizeCode(input);
  if (!group) return { ok: false, error: "Nhóm không được để trống. Ví dụ: D04" };
  if (!GROUP_RE.test(group)) {
    return { ok: false, error: `Nhóm "${String(input).trim()}" không hợp lệ. Ví dụ: D04` };
  }
  return { ok: true, value: group };
}

// Accepts "CT005", "CT005-D04", "CT005 - D04" style combined input.
export function splitCourseGroup(input) {
  const q = normalizeCourseQuery(input);
  return { courseCode: q.courseCode, groupCode: q.groupCode };
}

export function validateClientId(input) {
  const id = String(input || "").trim();
  if (!id) return { ok: false, error: "Thiếu clientId. Hãy tải lại trang." };
  if (!CLIENT_RE.test(id)) return { ok: false, error: "clientId không hợp lệ." };
  return { ok: true, value: id };
}

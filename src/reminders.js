// Date helpers, session status, and the notification channel abstraction (MVP).
// No exact class times anywhere: reminders are keyed by DATE + MORNING/AFTERNOON.

export const TIMEZONE = "Asia/Ho_Chi_Minh";

export function todayISO(timezone = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDays(aISO, bISO) {
  const t = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(aISO) - t(bISO)) / 86400000);
}

export function formatDateDisplay(iso) {
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
}

export function slotLabel(slot) {
  return slot === "AFTERNOON" ? "Chiều" : "Sáng";
}

// Visual status of one session relative to today. Never involves hours.
export function sessionStatus(sessionDateISO, today = todayISO()) {
  const d = diffDays(sessionDateISO, today);
  if (d < 0) return "PAST";
  if (d === 0) return "TODAY";
  return "UPCOMING";
}

// Dashboard tab of one session relative to today: today | tomorrow | past | future.
// "Ngày mai" means strictly tomorrow (today+1), never 10/10, 11/10, ...
export function sessionTab(sessionDateISO, today = todayISO()) {
  const d = diffDays(sessionDateISO, today);
  if (d < 0) return "past";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return "future";
}

export function relativeDayLabel(sessionDateISO, today = todayISO()) {
  const d = diffDays(sessionDateISO, today);
  if (d < 0) return "Đã qua";
  if (d === 0) return "Hôm nay";
  if (d === 1) return "Ngày mai";
  if (d <= 7) return `Còn ${d} ngày nữa`;
  return "Tuần sau";
}

// In-app reminder text for one session. Date + slot only, no times.
export function reminderText(session, when) {
  const code = `${session.course_code}-${session.group_code}`;
  const slot = slotLabel(session.slot);
  if (when === "TODAY") return `Hôm nay bạn có ${code} — ${slot} — ${session.room}.`;
  if (when === "TOMORROW") return `Ngày mai bạn có ${code} — ${slot} — ${session.room}.`;
  return `Sắp tới bạn có ${code} (${formatDateDisplay(session.date)}) — ${slot} — ${session.room}.`;
}

// Notification channel abstraction. MVP ships "inapp" only;
// Telegram / Web Push plug in here later without touching sync or UI logic.
export const channels = {
  inapp: {
    name: "inapp",
    // eslint-disable-next-line no-unused-vars
    async send(notification) {
      return { delivered: true, channel: "inapp" };
    },
  },
};

export function resolveChannel(name = "inapp") {
  return channels[name] || channels.inapp;
}

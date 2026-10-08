// CTU Practice Reminder frontend (vanilla JS, no build step).
// clientId identifies the user. No login, no personal data.

const $ = (id) => document.getElementById(id);
const toast = $("toast");

let clientId = localStorage.getItem("ctu_client_id");
if (!clientId) {
  clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  localStorage.setItem("ctu_client_id", clientId);
}
let currentFilter = "today";
let lastData = { subscriptions: [], sessions: [], recentPast: [], today: null };

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.hidden = false;
  toast.classList.toggle("error", isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 5000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Client-Id": clientId, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Lỗi ${res.status}. Vui lòng thử lại.`);
  }
  return data;
}

function slotIcon(slot) {
  return slot === "AFTERNOON" ? "🌤️" : "☀️";
}

function sessionHtml(s) {
  const badge = s.status === "TODAY" ? "Hôm nay" : s.relative;
  return `<div class="session${s.status === "TODAY" ? " today" : ""}">
    <span class="badge">${escapeHtml(badge)}</span>
    <p class="s-line"><b>${escapeHtml(s.weekday)} · ${escapeHtml(s.dateDisplay)}</b></p>
    <p class="s-line">${slotIcon(s.slot)} ${escapeHtml(s.slotLabel)}</p>
    <p class="s-line">📍 ${escapeHtml(s.room)}</p>
    ${s.teacher ? `<p class="s-line">👨‍🏫 ${escapeHtml(s.teacher)}</p>` : ""}
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function load() {
  $("loading").hidden = false;
  try {
    const [{ subscriptions }, sched, { reminder }, status] = await Promise.all([
      api("/api/subscriptions"),
      api("/api/schedules"),
      api("/api/reminder"),
      api("/api/status").catch(() => null),
    ]);
    renderSyncState(status);
    renderReminder(reminder);
    lastData = {
      subscriptions,
      sessions: sched.sessions || [],
      recentPast: sched.recentPast || [],
      today: sched.today || null,
    };
    renderCards(subscriptions, lastData.sessions, lastData.recentPast, currentFilter);
  } catch (e) {
    showToast(e.message, true);
    $("loading").textContent = "Không tải được dữ liệu. Kiểm tra kết nối rồi bấm Đồng bộ.";
  } finally {
    $("loading").hidden = true;
  }
}

function renderSyncState(status) {
  const el = $("syncState");
  const sum = status && status.summary;
  if (sum && (sum.worksheets > 0 || sum.sessions > 0 || sum.lastSyncAt)) {
    const when = sum.lastSyncAt ? new Date(sum.lastSyncAt).toLocaleString("vi-VN") : "chưa rõ";
    const stateTxt = sum.status === "success" ? "Ổn định"
      : sum.status === "partial" ? "Một số tuần lỗi (dữ liệu cũ vẫn giữ)"
      : sum.status === "error" ? "Lỗi đồng bộ (dữ liệu cũ vẫn giữ)" : "Chưa đồng bộ";
    el.textContent = `Đồng bộ lần cuối: ${when} · ${sum.worksheets} tuần · ${sum.sessions} buổi · ${stateTxt}.`;
    return;
  }
  if (!status || !status.sync || status.sync.length === 0) {
    el.textContent = "Chưa đồng bộ lần nào. Bấm “Đồng bộ” để lấy lịch mới nhất.";
    return;
  }
  const parts = status.sync.map((s) => {
    const when = s.last_sync_at ? new Date(s.last_sync_at).toLocaleString("vi-VN") : "chưa rõ";
    return s.last_status === "OK"
      ? `${s.week}: OK (${s.session_count} buổi, ${when})`
      : `${s.week}: lỗi (${when})`;
  });
  el.textContent = "Đồng bộ: " + parts.join(" · ");
}

// Exactly one nearest reminder, decided by the backend (/api/reminder).
// Friendly relative dates only (Hôm nay / Ngày mai / ...), never ISO, never null.
function renderReminder(reminder) {
  const section = $("notifySection");
  const list = $("notifyList");
  if (!reminder || !reminder.session) {
    section.hidden = false;
    list.innerHTML = `<li class="muted">Chưa có lịch học sắp tới.</li>`;
    return;
  }
  const s = reminder.session;
  const sub = reminder.subscription || {};
  const title = reminder.isToday ? "🔔 Lịch học hôm nay" : "🔔 Lịch học gần nhất";
  const head = s.courseName ? `${s.courseCode} - ${s.courseName}` : (s.courseCode || "Lịch học");
  const rows = [`<b>${escapeHtml(title)}</b>`, escapeHtml(head)];
  if (sub.groupCode || s.groupCode) rows.push(`Nhóm ${escapeHtml(sub.groupCode || s.groupCode)}`);
  rows.push(`${escapeHtml(s.relative || "")} · ${escapeHtml(s.slotLabel || "")}`);
  if (s.room) rows.push(`Phòng ${escapeHtml(s.room)}`);
  if (s.teacher) rows.push(escapeHtml(s.teacher));
  if (s.weekday && s.dateDisplay) rows.push(`<span class="muted">${escapeHtml(s.weekday)} · ${escapeHtml(s.dateDisplay)}</span>`);
  section.hidden = false;
  list.innerHTML = `<li>${rows.filter(Boolean).join("<br>")}</li>`;
}

function matchFilter(s) {
  if (!lastData.today) return currentFilter === "all";
  if (currentFilter === "today") return s.date === lastData.today;
  if (currentFilter === "tomorrow") return s.date === addDaysISO(lastData.today, 1);
  if (currentFilter === "past") return s.date < lastData.today;
  return true; // all
}

function emptyFilterMessage() {
  if (currentFilter === "today") return "Hôm nay không có lịch học.";
  if (currentFilter === "tomorrow") return "Ngày mai không có lịch học.";
  if (currentFilter === "past") return "Chưa có lịch đã qua.";
  return "Chưa có lịch cho môn này.";
}

function renderCards(subs, sessions, recentPast) {
  const cards = $("cards");
  $("empty").hidden = subs.length !== 0;
  if (subs.length === 0) {
    cards.innerHTML = "";
    return;
  }
  const bySub = new Map(subs.map((s) => [s.id, []]));
  for (const s of [...sessions, ...recentPast]) {
    if (bySub.has(s.subscriptionId)) bySub.get(s.subscriptionId).push(s);
  }
  cards.innerHTML = subs.map((sub) => {
    const list = (bySub.get(sub.id) || []).filter(matchFilter)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const shown = currentFilter === "all" ? list.slice(0, 10) : list;
    const body = shown.length === 0
      ? `<p class="muted">${emptyFilterMessage()}</p>`
      : shown.map(sessionHtml).join("");
    const first = shown.find((s) => s.title) || list.find((s) => s.title);
    const title = first ? first.title : "";
    return `<article class="card">
      <div class="sub-card-head">
        <div>
          <div class="sub-title">${escapeHtml(title ? `${sub.courseCode} - ${title}` : sub.courseCode)}</div>
          ${sub.groupCode ? `<div class="sub-course">Nhóm ${escapeHtml(sub.groupCode)}</div>` : ""}
        </div>
        <button class="btn danger" data-del="${sub.id}" title="Bỏ theo dõi">×</button>
      </div>
      ${body}
    </article>`;
  }).join("");
  cards.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Bỏ theo dõi môn này?")) return;
      try {
        await api(`/api/subscriptions/${btn.dataset.del}`, { method: "DELETE" });
        await load();
      } catch (e) {
        showToast(e.message, true);
      }
    });
  });
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const course = $("courseInput").value.trim();
  const group = $("groupInput").value.trim();
  if (!course || !group) {
    showToast("Nhập mã môn và nhóm. Ví dụ: CT005 / D04.", true);
    return;
  }
  try {
    const r = await api("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ courseCode: course, groupCode: group }),
    });
    $("courseInput").value = "";
    $("groupInput").value = "";
    showToast(r.created ? `Đã theo dõi ${r.subscription.courseCode}-${r.subscription.groupCode}.` : "Môn này đã được theo dõi.");
    await load();
    if ((!r.matches || r.matches.length === 0) && (!r.recentPast || r.recentPast.length === 0)) {
      showToast("Đã lưu. Chưa thấy lịch — bấm “Đồng bộ” để cập nhật.", false);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderCards(lastData.subscriptions, lastData.sessions, lastData.recentPast);
  });
});

$("syncBtn").addEventListener("click", async () => {
  const btn = $("syncBtn");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Đang lấy dữ liệu từ Google Sheet…";
  try {
    const r = await api("/api/sync", { method: "POST" });
    const t = r.totals || {};
    showToast(`Đồng bộ xong: ${t.added || 0} mới, ${t.changed || 0} đổi (giữ dữ liệu cũ khi lỗi).`);
    await load();
  } catch (e) {
    // Dữ liệu cũ vẫn hiển thị, chỉ báo lỗi.
    showToast(e.message + " Dữ liệu cũ vẫn được giữ.", true);
    await load().catch(() => {});
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

load();

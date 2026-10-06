/* 생체 데이터 뷰어 – 화면 로직 */
(function () {
  const { ChartGroup, sparkBars, hideTooltip } = window.Charts;
  const $ = s => document.querySelector(s);
  const main = $("#main");
  const state = { meta: null, subjects: [], charts: [] };

  // ---------------------------------------------------------------- utils
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }
  async function api(path) {
    const res = await fetch(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
    return body;
  }
  const num = (v, d = 1) => v == null || isNaN(v) ? "–" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const hm = m => {
    if (m == null) return "–";
    m = Math.round(m);
    const hh = Math.floor(m / 60), mm = m % 60;
    return hh ? (mm ? `${hh}시간 ${mm}분` : `${hh}시간`) : `${mm}분`;
  };
  const addDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
  const WEEK = "일월화수목금토";
  const dateLabel = iso => {
    const d = new Date(iso + "T00:00:00Z");
    return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WEEK[d.getUTCDay()]})`;
  };
  const shortDate = iso => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  const timeOf = t => t.slice(11, 16);

  // 상태 → 표시 (색 + 라벨, 색만으로 의미를 전달하지 않도록 항상 라벨 동반)
  const PRESENCE = {
    present: { label: "재실", color: "var(--st-present)", cls: "present" },
    absent: { label: "비움", color: "var(--st-absent)", cls: "absent" },
    disconnected: { label: "연결 끊김", color: "var(--st-offline)", cls: "offline" },
    booting: { label: "부팅중", color: "var(--st-offline)", cls: "offline" },
  };
  const SLEEP = {
    asleep: { label: "수면 중", color: "var(--st-asleep)", cls: "asleep" },
    bedtime: { label: "취침", color: "var(--st-inbed)", cls: "inbed" },
    wake: { label: "기상", color: "var(--st-inbed)", cls: "inbed" },
  };
  function currentStatus(s) {
    const p = s.latest_presence;
    if (p === "disconnected" || p === "booting") return { label: "오프라인", cls: "offline" };
    if (p === "absent") return { label: "비움", cls: "absent" };
    if (s.latest_sleep === "asleep") return { label: "수면 중", cls: "asleep" };
    if (s.latest_sleep) return { label: "침상 (" + SLEEP[s.latest_sleep].label + ")", cls: "inbed" };
    return { label: "재실 · 깨어 있음", cls: "present" };
  }
  const statusBadge = s => {
    const st = currentStatus(s);
    return h("span", { class: "badge" }, h("i", { class: "dot " + st.cls }), st.label);
  };
  const tile = (label, value, unit, note) =>
    h("div", { class: "tile" }, h("div", { class: "label" }, label),
      h("div", { class: "value" }, value, unit ? h("small", null, unit) : null),
      note ? h("div", { class: "note" }, note) : null);

  function clearCharts() {
    state.charts.forEach(c => c.destroy());
    state.charts = [];
    hideTooltip();
  }

  // ---------------------------------------------------------------- theme
  const THEMES = ["auto", "light", "dark"], THEME_LABEL = { auto: "자동", light: "밝게", dark: "어둡게" };
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    $("#themeBtn").textContent = "테마: " + THEME_LABEL[t];
    try { localStorage.setItem("theme", t); } catch (e) { /* 저장 불가 무시 */ }
    // 색이 CSS 변수라 다시 그릴 필요 없음
  }
  let theme = "auto";
  try { theme = localStorage.getItem("theme") || "auto"; } catch (e) { /* noop */ }
  applyTheme(theme);
  $("#themeBtn").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
  });

  // ---------------------------------------------------------------- sidebar
  function filteredSubjects() {
    const fac = $("#facilityFilter").value, q = $("#search").value.trim();
    return state.subjects.filter(s => (!fac || s.facility_code === fac) && (!q || s.subject_name.includes(q)));
  }
  function renderSidebar() {
    const list = $("#subjectList"), cur = currentSubjectId();
    list.replaceChildren();
    let lastFac = null;
    for (const s of filteredSubjects()) {
      if (s.facility_code !== lastFac) {
        list.append(h("div", { class: "group" }, `${s.facility_code} ${s.facility_name}`));
        lastFac = s.facility_code;
      }
      const st = currentStatus(s);
      list.append(h("a", {
        class: "subject-item", href: `#/s/${s.subject_id}`, "aria-current": s.subject_id === cur ? "page" : null,
        title: st.label,
      }, h("i", { class: "dot " + st.cls }), h("span", { class: "name" }, s.subject_name),
        h("span", { class: "sub" }, st.label)));
    }
    if (!list.children.length) list.append(h("div", { class: "group" }, "검색 결과 없음"));
  }
  $("#facilityFilter").addEventListener("change", () => { renderSidebar(); if (!currentSubjectId()) route(); });
  $("#search").addEventListener("input", () => { renderSidebar(); if (!currentSubjectId()) route(); });

  // ---------------------------------------------------------------- router
  function parseHash() {
    const [path, qs] = location.hash.replace(/^#/, "").split("?");
    return { parts: path.split("/").filter(Boolean), q: new URLSearchParams(qs || "") };
  }
  function currentSubjectId() {
    const { parts } = parseHash();
    return parts[0] === "s" ? Number(parts[1]) : null;
  }
  let routeToken = 0;
  async function route() {
    const token = ++routeToken;
    const { parts, q } = parseHash();
    clearCharts();
    renderSidebar();
    try {
      if (parts[0] === "s" && parts[1]) {
        const s = state.subjects.find(x => x.subject_id === Number(parts[1]));
        if (!s) throw new Error("대상자를 찾을 수 없습니다");
        const tab = parts[2] || "day";
        if (tab === "trend") await viewTrend(s, q, token);
        else if (tab === "anomalies") await viewAnomalies(s, token);
        else await viewDay(s, parts[3], q, token);
      } else viewOverview();
    } catch (e) {
      if (token !== routeToken) return;
      main.replaceChildren(h("p", { class: "error" }, "오류: " + e.message));
    }
  }
  window.addEventListener("hashchange", () => { route(); main.focus({ preventScroll: true }); });

  // ---------------------------------------------------------------- overview
  function viewOverview() {
    const subs = filteredSubjects(), m = state.meta;
    const counts = { asleep: 0, inbed: 0, present: 0, absent: 0, offline: 0 };
    subs.forEach(s => counts[currentStatus(s).cls]++);
    const head = h("div", { class: "page-head" }, h("h1", null, "전체 현황"),
      h("span", { class: "subtle" }, `${dateLabel(m.first_date)} ~ ${dateLabel(m.last_date)}`));
    const tiles = h("div", { class: "tiles" },
      tile("대상자", num(subs.length, 0), "명", `시설 ${new Set(subs.map(s => s.facility_code)).size}곳`),
      tile("측정 데이터", num(subs.reduce((a, s) => a + (s.readings || 0), 0), 0), "건", "5분 단위"),
      tile("지금 수면 중", num(counts.asleep + counts.inbed, 0), "명", counts.inbed ? `침상 ${counts.inbed}명 포함` : null),
      tile("지금 재실 · 깨어 있음", num(counts.present, 0), "명"),
      tile("지금 비움", num(counts.absent, 0), "명"),
      tile("센서 오프라인", num(counts.offline, 0), "명"));
    const sections = [];
    const byFac = new Map();
    subs.forEach(s => { if (!byFac.has(s.facility_code)) byFac.set(s.facility_code, []); byFac.get(s.facility_code).push(s); });
    for (const [code, list] of byFac) {
      sections.push(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", null, `${code} ${list[0].facility_name}`), h("span", { class: "muted" }, `${list.length}명`)),
        h("div", { class: "cards" }, list.map(subjectCard))));
    }
    main.replaceChildren(head, tiles, ...sections,
      h("p", { class: "hint" }, "최근 7일 = 데이터 마지막 날짜 기준. 막대는 최근 14일 밤별 수면 시간(마지막 막대 = 가장 최근)."));
  }
  function subjectCard(s) {
    const spark = (s.sleep_14d || []).map(v => v == null ? null : v / 60);
    return h("a", { class: "subject-card", href: `#/s/${s.subject_id}` },
      h("div", { class: "top" }, h("span", { class: "nm" }, s.subject_name), statusBadge(s)),
      h("div", { class: "stats" },
        h("div", null, h("b", null, s.sleep_avg_min_7d == null ? "–" : num(s.sleep_avg_min_7d / 60)), "수면 시간/일"),
        h("div", null, h("b", null, num(s.hr_avg_7d)), "심박 bpm"),
        h("div", null, h("b", null, num(s.rr_avg_7d)), "호흡 rpm")),
      sparkBars(spark, { max: 24 }),
      h("div", { class: "spark-label" }, h("span", null, "최근 14일 수면"),
        h("span", null, `가동률 ${num(s.sensor_online_pct)}% · 이탈 ${num(s.exits_7d, 0)}회/7일`)));
  }

  // ---------------------------------------------------------------- subject header
  function subjectHeader(s, tab) {
    const base = `#/s/${s.subject_id}`;
    const tabs = [["day", "하루 상세", base + "/day"], ["trend", "기간 추이", base + "/trend"], ["anomalies", "이상치", base + "/anomalies"]];
    return [
      h("div", { class: "page-head" },
        h("h1", null, s.subject_name),
        statusBadge(s),
        h("span", { class: "subtle" }, `${s.facility_code} ${s.facility_name}`),
        s.is_name_masked ? h("span", { class: "badge" }, "이름 가림") : null,
        h("span", { class: "muted" }, `${s.first_at} ~ ${s.last_at} · ${num(s.days, 0)}일 · 마지막 측정 ${s.latest_at ? s.latest_at.replace("T", " ") : "–"}`)),
      h("div", { class: "tiles" },
        tile("평균 수면 (최근 7일)", s.sleep_avg_min_7d == null ? "–" : hm(s.sleep_avg_min_7d)),
        tile("평균 심박 (최근 7일)", num(s.hr_avg_7d), "bpm", `전체 평균 ${num(s.hr_avg)}`),
        tile("평균 호흡 (최근 7일)", num(s.rr_avg_7d), "rpm", `전체 평균 ${num(s.rr_avg)}`),
        tile("재실률 (최근 7일)", num(s.present_pct_7d), "%"),
        tile("이탈 (최근 7일)", num(s.exits_7d, 0), "회", "재실 → 비움 전환"),
        tile("이상치 (최근 7일)", num(s.anomalies_7d, 0), "건", "|Z-점수| ≥ 4")),
      h("nav", { class: "tabs" }, tabs.map(([k, label, href]) =>
        h("a", { href, "aria-current": k === tab ? "page" : null }, label))),
    ];
  }

  // ---------------------------------------------------------------- day view
  async function viewDay(s, date, q, token) {
    date = date || addDays(s.last_at, s.last_at > s.first_at ? -1 : 0);
    const win = q.get("w") === "night" ? "night" : "day";
    const existing = main.querySelector(".day-view");
    if (!existing || existing.dataset.subject !== String(s.subject_id))
      main.replaceChildren(...subjectHeader(s, "day"), h("div", { class: "day-view", "data-subject": s.subject_id }, h("p", { class: "muted" }, "불러오는 중…")));
    main.querySelector(".day-view").classList.add("loading");
    const data = await api(`/api/subjects/${s.subject_id}/day?date=${date}&window=${win}`);
    if (token !== routeToken) return;

    const n = 288, start = data.start;
    const slots = new Array(n).fill(null);
    const startMs = Date.parse(start + ":00Z");
    for (const r of data.readings) {
      const i = Math.round((Date.parse(r.t + ":00Z") - startMs) / 3e5);
      if (i >= 0 && i < n) slots[i] = r;
    }
    const slotTime = i => new Date(startMs + i * 3e5).toISOString().slice(0, 16);
    const rs = data.readings;
    const cnt = f => rs.filter(f).length * 5;
    const avg = key => { const v = rs.map(r => r[key]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const flagged = rs.filter(r => Math.abs(r.hr_z) >= 4 || Math.abs(r.rr_z) >= 4).length;

    const base = `#/s/${s.subject_id}/day`;
    const go = (d, w) => { location.hash = `${base}/${d}${w === "night" ? "?w=night" : ""}`; };
    const prev = addDays(date, -1), next = addDays(date, 1);
    const controls = h("div", { class: "controls" },
      h("button", { class: "btn", type: "button", disabled: prev < s.first_at, onclick: () => go(prev, win), "aria-label": "이전 날" }, "◀"),
      h("input", { class: "control", type: "date", value: date, min: s.first_at, max: s.last_at, "aria-label": "날짜",
        onchange: e => e.target.value && go(e.target.value, win) }),
      h("button", { class: "btn", type: "button", disabled: next > s.last_at, onclick: () => go(next, win), "aria-label": "다음 날" }, "▶"),
      h("div", { class: "seg", role: "group", "aria-label": "시간 범위" },
        h("button", { type: "button", "aria-pressed": win === "day" ? "true" : "false", onclick: () => go(date, "day") }, "하루 (0~24시)"),
        h("button", { type: "button", "aria-pressed": win === "night" ? "true" : "false", onclick: () => go(date, "night") }, "밤 (12시~다음날 12시)")),
      h("a", { class: "btn", href: `/api/subjects/${s.subject_id}/day.csv?date=${date}&window=${win}` }, "CSV 내려받기"));

    const title = h("div", { class: "section-head" }, h("h2", null, `${dateLabel(date)}${win === "night" ? " 12시 ~ 다음날 12시" : ""}`),
      h("span", { class: "muted" }, `${rs.length}/${n}개 측정`));

    const tiles = h("div", { class: "tiles" },
      tile("수면", hm(cnt(r => r.sleep === "asleep")), null, `침상 ${hm(cnt(r => r.sleep))}`),
      tile("재실", hm(cnt(r => r.presence === "present"))),
      tile("비움", hm(cnt(r => r.presence === "absent"))),
      tile("센서 오프라인", hm(cnt(r => r.presence === "disconnected" || r.presence === "booting") + (n - rs.length) * 5)),
      tile("평균 심박", num(avg("hr")), "bpm", `측정 ${rs.filter(r => r.hr != null).length}회`),
      tile("평균 호흡", num(avg("rr")), "rpm", `측정 ${rs.filter(r => r.rr != null).length}회`),
      tile("이상치", num(flagged, 0), "건", "|Z-점수| ≥ 4"));

    const chartBox = h("div", { class: "chart-card section" });
    const val = (i, k) => slots[i] ? slots[i][k] : null;
    const isFlag = (i, k) => slots[i] != null && slots[i][k] != null && Math.abs(slots[i][k]) >= 4;
    const flagLegend = [{ label: "이상치 |Z| ≥ 4", color: "var(--critical)", kind: "dot" }];
    const xTicks = [];
    for (let i = 0; i < n; i += 24) xTicks.push({ i, label: `${+slotTime(i).slice(11, 13)}시` });
    const opts = {
      n, xTicks, ariaLabel: "하루 5분 단위 상태·심박·호흡·수면깊이 차트. 좌우 화살표로 시간 이동",
      panels: [
        {
          type: "strip", title: "상태", height: 40,
          legend: [
            { label: "재실", color: PRESENCE.present.color }, { label: "비움", color: PRESENCE.absent.color },
            { label: "오프라인", color: PRESENCE.disconnected.color },
            { label: "수면 중", color: SLEEP.asleep.color }, { label: "침상 (취침·기상)", color: SLEEP.bedtime.color }],
          rows: [
            { label: "재실", color: i => slots[i] ? PRESENCE[slots[i].presence].color : null },
            { label: "수면", color: i => slots[i] && slots[i].sleep ? SLEEP[slots[i].sleep].color : null }],
        },
        { type: "line", title: "심박", unit: "bpm", height: 110, value: i => val(i, "hr"), flag: i => isFlag(i, "hr_z"), legend: flagLegend },
        { type: "line", title: "호흡", unit: "rpm", height: 110, value: i => val(i, "rr"), flag: i => isFlag(i, "rr_z"), legend: flagLegend },
        { type: "line", title: "수면 깊이", unit: "0~100", height: 80, area: true, yMin: 0, yMax: 100, maxGap: 0, value: i => val(i, "depth") },
      ],
      tooltip: i => {
        const r = slots[i], head = slotTime(i).replace("T", " ");
        if (!r) return { head, rows: [{ label: "데이터 없음", value: "–" }] };
        const rows = [{ label: "재실 상태", value: PRESENCE[r.presence].label, color: PRESENCE[r.presence].color, kind: "box" }];
        if (r.sleep) rows.push({ label: "수면 상태", value: SLEEP[r.sleep].label, color: SLEEP[r.sleep].color, kind: "box" });
        rows.push({ label: "심박 bpm" + (r.hr_z != null ? ` (Z ${num(r.hr_z)})` : ""), value: num(r.hr), color: "var(--series)" });
        rows.push({ label: "호흡 rpm" + (r.rr_z != null ? ` (Z ${num(r.rr_z)})` : ""), value: num(r.rr), color: "var(--series)" });
        if (r.depth != null) rows.push({ label: "수면 깊이", value: num(r.depth), color: "var(--series)" });
        if (r.dist != null) rows.push({ label: "거리 m", value: num(r.dist, 2) });
        return { head, rows };
      },
    };

    const episodes = data.episodes.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["시작 (취침)", "잠든 시각", "종료", "침상 시간", "수면 시간", "평균 깊이", "평균 심박", "최저 심박", "평균 호흡"].map(t => h("th", null, t)))),
      h("tbody", null, data.episodes.map(e => h("tr", null,
        h("td", null, e.start_at.replace("T", " ")), h("td", { class: "num" }, e.onset_at ? timeOf(e.onset_at) : "–"),
        h("td", { class: "num" }, e.end_at.replace("T", " ")), h("td", null, hm(e.in_bed_min)), h("td", null, hm(e.asleep_min)),
        h("td", { class: "num" }, num(e.avg_sleep_depth)), h("td", { class: "num" }, num(e.avg_hr_asleep)),
        h("td", { class: "num" }, num(e.min_hr_asleep)), h("td", { class: "num" }, num(e.avg_rr_asleep)))))))
      : h("p", { class: "muted" }, "이 범위에는 수면 기록이 없습니다.");

    const raw = h("details", { class: "section" }, h("summary", null, `5분 데이터 표 보기 (${rs.length}행)`),
      h("div", { class: "table-wrap scroll-y" }, h("table", null,
        h("thead", null, h("tr", null, ["시간", "재실", "수면", "수면깊이", "심박", "심박 Z", "호흡", "호흡 Z", "거리 m"].map(t => h("th", null, t)))),
        h("tbody", null, rs.map(r => h("tr", null,
          h("td", { class: "num" }, r.t.replace("T", " ")), h("td", { class: "l" }, PRESENCE[r.presence].label),
          h("td", { class: "l" }, r.sleep ? SLEEP[r.sleep].label : ""), h("td", { class: "num" }, num(r.depth)),
          h("td", { class: "num" + (Math.abs(r.hr_z) >= 4 ? " flag-txt" : "") }, num(r.hr)), h("td", { class: "num" }, num(r.hr_z, 2)),
          h("td", { class: "num" + (Math.abs(r.rr_z) >= 4 ? " flag-txt" : "") }, num(r.rr)), h("td", { class: "num" }, num(r.rr_z, 2)),
          h("td", { class: "num" }, num(r.dist, 2))))))));

    const view = h("div", { class: "day-view", "data-subject": s.subject_id }, controls, title, tiles, chartBox,
      h("p", { class: "hint" }, "차트 위에 마우스를 올리거나, 차트를 선택하고 ← → 키(Shift+←→ = 1시간)로 시점별 값을 볼 수 있습니다. 15분 이하 측정 공백은 선으로 잇습니다."),
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "수면 기록")), episodes), raw);
    main.querySelector(".day-view").replaceWith(view);
    state.charts.push(new ChartGroup(chartBox, opts));
  }

  // ---------------------------------------------------------------- trend view
  const RANGES = [["7", "최근 7일"], ["30", "최근 30일"], ["90", "최근 90일"], ["all", "전체"]];
  async function viewTrend(s, q, token) {
    const range = RANGES.some(r => r[0] === q.get("r")) ? q.get("r") : "30";
    main.replaceChildren(...subjectHeader(s, "trend"), h("p", { class: "muted" }, "불러오는 중…"));
    const daily = await api(`/api/subjects/${s.subject_id}/daily`);
    if (token !== routeToken) return;
    const byDate = new Map(daily.map(d => [d.date, d]));
    const last = s.last_at, first = range === "all" ? s.first_at : [s.first_at, addDays(last, -Number(range) + 1)].sort()[1];
    const dates = [];
    for (let d = first; d <= last; d = addDays(d, 1)) dates.push(d);
    const rows = dates.map(d => byDate.get(d) || { date: d });
    const n = rows.length;
    const v = (i, k) => rows[i][k] == null ? null : rows[i][k];

    const controls = h("div", { class: "controls" }, h("div", { class: "seg", role: "group", "aria-label": "기간" },
      RANGES.map(([k, label]) => h("button", {
        type: "button", "aria-pressed": k === range ? "true" : "false",
        onclick: () => { location.hash = `#/s/${s.subject_id}/trend?r=${k}`; },
      }, label))), h("span", { class: "muted" }, `${dateLabel(first)} ~ ${dateLabel(last)}`));

    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const wavg = (k, w) => { let a = 0, b = 0; rows.forEach(r => { if (r[k] != null && r[w]) { a += r[k] * r[w]; b += r[w]; } }); return b ? a / b : null; };
    const sleepRows = rows.filter(r => r.asleep_min != null && r.date < last);
    const tiles = h("div", { class: "tiles" },
      tile("평균 수면", sleepRows.length ? hm(sleepRows.reduce((a, r) => a + r.asleep_min, 0) / sleepRows.length) : "–", null, `${sleepRows.length}일 기준`),
      tile("평균 심박", num(wavg("hr_avg", "slots")), "bpm"),
      tile("평균 호흡", num(wavg("rr_avg", "slots")), "rpm"),
      tile("재실률", num(100 * sum("present_min") / Math.max(1, sum("slots") * 5)), "%"),
      tile("이탈", num(sum("exit_count"), 0), "회"),
      tile("이상치", num(sum("anomalies"), 0), "건"));

    const stride = Math.ceil(n / 10);
    const xTicks = rows.map((r, i) => ({ i, label: shortDate(r.date) })).filter((t, i) => i % stride === 0);
    const hours = (i, k) => v(i, k) == null ? null : v(i, k) / 60;
    const chartBox = h("div", { class: "chart-card section" });
    const opts = {
      n, xTicks, ariaLabel: "일별 수면·심박·호흡·재실 추이. 좌우 화살표로 날짜 이동, Enter 로 하루 상세",
      onClick: i => { location.hash = `#/s/${s.subject_id}/day/${rows[i].date}`; },
      panels: [
        { type: "columns", title: "수면 시간", unit: "시간 · 그날 정오 ~ 다음날 정오", height: 100, zero: true, value: i => hours(i, "asleep_min") },
        { type: "line", title: "심박", unit: "bpm", height: 100, value: i => v(i, "hr_avg"), band: [i => v(i, "hr_min"), i => v(i, "hr_max")], maxGap: 0,
          legend: [{ label: "일 평균", color: "var(--series)", kind: "line" }, { label: "최저 ~ 최고", color: "var(--band)" }] },
        { type: "line", title: "호흡", unit: "rpm", height: 100, value: i => v(i, "rr_avg"), band: [i => v(i, "rr_min"), i => v(i, "rr_max")], maxGap: 0,
          legend: [{ label: "일 평균", color: "var(--series)", kind: "line" }, { label: "최저 ~ 최고", color: "var(--band)" }] },
        { type: "stack", title: "재실 구성", unit: "시간", height: 90, zero: true,
          legend: [{ label: "재실", color: PRESENCE.present.color }, { label: "비움", color: PRESENCE.absent.color }, { label: "오프라인", color: PRESENCE.disconnected.color }],
          parts: [
            { value: i => hours(i, "present_min"), color: PRESENCE.present.color },
            { value: i => hours(i, "absent_min"), color: PRESENCE.absent.color },
            { value: i => hours(i, "offline_min"), color: PRESENCE.disconnected.color }] },
        { type: "columns", title: "이탈 횟수", unit: "회 (재실 → 비움)", height: 60, zero: true, value: i => v(i, "exit_count") },
      ],
      tooltip: i => {
        const r = rows[i];
        if (r.slots == null) return { head: dateLabel(r.date), rows: [{ label: "데이터 없음", value: "–" }] };
        return {
          head: dateLabel(r.date) + " · 클릭하면 하루 상세",
          rows: [
            { label: r.episodes ? `수면 (${r.episodes}회)` : "수면", value: hm(r.asleep_min), color: "var(--series)", kind: "box" },
            { label: "심박 평균" + (r.hr_min == null ? "" : ` (${num(r.hr_min)}~${num(r.hr_max)})`), value: num(r.hr_avg), color: "var(--series)" },
            { label: "호흡 평균" + (r.rr_min == null ? "" : ` (${num(r.rr_min)}~${num(r.rr_max)})`), value: num(r.rr_avg), color: "var(--series)" },
            { label: "재실", value: hm(r.present_min), color: PRESENCE.present.color, kind: "box" },
            { label: "비움", value: hm(r.absent_min), color: PRESENCE.absent.color, kind: "box" },
            { label: "오프라인", value: hm(r.offline_min), color: PRESENCE.disconnected.color, kind: "box" },
            { label: "이탈", value: num(r.exit_count, 0) + "회" },
            { label: "이상치", value: num(r.anomalies, 0) + "건" },
          ],
        };
      },
    };

    const table = h("details", { class: "section" }, h("summary", null, `일별 표 보기 (${n}일)`),
      h("div", { class: "table-wrap scroll-y" }, h("table", null,
        h("thead", null, h("tr", null, ["날짜", "수면", "수면 효율 %", "심박 평균", "심박 범위", "호흡 평균", "호흡 범위", "재실", "비움", "오프라인", "이탈", "이상치"].map(t => h("th", null, t)))),
        h("tbody", null, rows.slice().reverse().map(r => h("tr", {
          class: "link", onclick: () => { location.hash = `#/s/${s.subject_id}/day/${r.date}`; },
        },
          h("td", null, dateLabel(r.date)), h("td", null, hm(r.asleep_min)), h("td", { class: "num" }, num(r.sleep_efficiency_pct)),
          h("td", { class: "num" }, num(r.hr_avg)), h("td", { class: "num" }, r.hr_min == null ? "–" : `${num(r.hr_min)}~${num(r.hr_max)}`),
          h("td", { class: "num" }, num(r.rr_avg)), h("td", { class: "num" }, r.rr_min == null ? "–" : `${num(r.rr_min)}~${num(r.rr_max)}`),
          h("td", null, hm(r.present_min)), h("td", null, hm(r.absent_min)), h("td", null, hm(r.offline_min)),
          h("td", { class: "num" }, num(r.exit_count, 0)), h("td", { class: "num" }, num(r.anomalies, 0))))))));

    main.replaceChildren(...subjectHeader(s, "trend"), controls, tiles, chartBox,
      h("p", { class: "hint" }, "날짜를 클릭하면 그날의 5분 단위 상세로 이동합니다. 마지막 날은 내보내기 시점까지만 포함되어 짧게 보일 수 있습니다."),
      table);
    state.charts.push(new ChartGroup(chartBox, opts));
  }

  // ---------------------------------------------------------------- anomalies
  async function viewAnomalies(s, token) {
    main.replaceChildren(...subjectHeader(s, "anomalies"), h("p", { class: "muted" }, "불러오는 중…"));
    const rows = await api(`/api/subjects/${s.subject_id}/anomalies?limit=500`);
    if (token !== routeToken) return;
    const body = rows.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["시간", "재실", "수면", "심박", "심박 Z", "호흡", "호흡 Z", "구분"].map(t => h("th", null, t)))),
      h("tbody", null, rows.map(r => h("tr", { class: "link", onclick: () => { location.hash = `#/s/${s.subject_id}/day/${r.t.slice(0, 10)}`; } },
        h("td", { class: "num" }, r.t.replace("T", " ")), h("td", { class: "l" }, PRESENCE[r.presence].label),
        h("td", { class: "l" }, r.sleep ? SLEEP[r.sleep].label : ""),
        h("td", { class: "num" }, num(r.hr)), h("td", { class: "num" + (r.hr_flag ? " flag-txt" : "") }, num(r.hr_z, 2)),
        h("td", { class: "num" }, num(r.rr)), h("td", { class: "num" + (r.rr_flag ? " flag-txt" : "") }, num(r.rr_z, 2)),
        h("td", { class: "l" }, [r.hr_flag ? "▲ 심박" : null, r.rr_flag ? "▲ 호흡" : null].filter(Boolean).join(" · ")))))))
      : h("p", { class: "muted" }, "이상치가 없습니다.");
    main.replaceChildren(...subjectHeader(s, "anomalies"),
      h("p", { class: "subtle" }, `Z-점수(개인 기준선 대비 편차)의 절댓값이 4 이상인 측정, 최근 ${rows.length}건. 행을 클릭하면 그날 상세로 이동합니다.`),
      body);
  }

  // ---------------------------------------------------------------- boot
  (async function boot() {
    try {
      const [meta, subjects] = await Promise.all([api("/api/meta"), api("/api/subjects")]);
      state.meta = meta;
      state.subjects = subjects;
      $("#meta").textContent = `측정 ${num(meta.readings, 0)}건 · 대상자 ${meta.subjects}명 · ${meta.first_date} ~ ${meta.last_date}`;
      const sel = $("#facilityFilter");
      for (const f of meta.facilities) sel.append(h("option", { value: f.facility_code }, `${f.facility_code} ${f.facility_name} (${f.subjects})`));
      route();
    } catch (e) {
      main.replaceChildren(h("p", { class: "error" }, "데이터를 불러오지 못했습니다: " + e.message));
    }
  })();
})();

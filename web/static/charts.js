/* 의존성 없는 SVG 차트: 같은 x축을 공유하는 패널 묶음 + 공통 십자선/툴팁 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const M = { left: 46, right: 12, top: 8, bottom: 6, axis: 20 };

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / count;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => raw <= s) || 10 * pow;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }
  const fmtTick = v => Math.abs(v) >= 1000 ? v.toLocaleString("ko-KR") : String(+v.toFixed(2));

  // 상단만 둥근 막대 (기준선 쪽은 각짐)
  function barPath(x, y, w, hgt, r) {
    if (hgt <= 0) return "";
    r = Math.min(r, w / 2, hgt);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }

  const tooltip = () => document.getElementById("tooltip");

  function showTooltip(content, clientX, clientY) {
    const tt = tooltip();
    tt.replaceChildren();
    tt.appendChild(h("div", "tt-head", content.head));
    for (const r of content.rows) {
      const row = h("div", "tt-row");
      const key = h("i", "k" + (r.kind === "box" ? " box" : ""));
      key.style.background = r.color || "transparent";
      row.append(key, h("b", null, r.value), h("span", null, r.label));
      tt.appendChild(row);
    }
    tt.hidden = false;
    const pad = 14, rect = tt.getBoundingClientRect();
    let x = clientX + pad, y = clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, clientY - rect.height - pad);
    tt.style.left = Math.max(8, x) + "px";
    tt.style.top = y + "px";
  }
  function hideTooltip() { tooltip().hidden = true; }

  class ChartGroup {
    /**
     * opts.n            x 슬롯 수
     * opts.xTicks       [{i, label}]  (맨 아래 패널에 표시)
     * opts.panels       [{type:'strip'|'line'|'columns'|'stack', title, unit, legend, height, ...}]
     * opts.tooltip(i)   -> {head, rows:[{label, value, color, kind}]}
     * opts.onClick(i)   (선택)
     */
    constructor(container, opts) {
      this.c = container;
      this.o = opts;
      this.idx = null;
      this.root = h("div", "chart-group");
      this.root.tabIndex = 0;
      this.root.setAttribute("role", "img");
      this.root.setAttribute("aria-label", opts.ariaLabel || "차트 (좌우 화살표로 이동)");
      container.replaceChildren(this.root);
      this.root.addEventListener("keydown", e => this.onKey(e));
      this.root.addEventListener("blur", () => this.clear());
      this.render();
      this.ro = new ResizeObserver(() => {
        if (this.root.clientWidth !== this.width) this.render();
      });
      this.ro.observe(this.root);
    }

    destroy() { this.ro.disconnect(); hideTooltip(); }

    render() {
      const o = this.o;
      this.width = this.root.clientWidth || 600;
      this.root.replaceChildren();
      this.layers = [];
      const W = this.width, pw = W - M.left - M.right;
      this.slotW = pw / Math.max(1, o.n);
      o.panels.forEach((p, pi) => {
        const last = pi === o.panels.length - 1;
        const panel = h("div", "panel");
        const title = h("div", "panel-title");
        title.appendChild(h("span", null, p.title));
        if (p.unit) title.appendChild(h("span", "unit", p.unit));
        if (p.legend && p.legend.length) {
          const lg = h("span", "legend");
          for (const it of p.legend) {
            const s = h("span");
            const sw = h("i", it.kind === "line" ? "ln" : it.kind === "dot" ? "dot" : "sw");
            sw.style.background = it.color;
            s.append(sw, document.createTextNode(it.label));
            lg.appendChild(s);
          }
          title.appendChild(lg);
        }
        panel.appendChild(title);
        const ph = p.height || 110;
        const H = M.top + ph + M.bottom + (last ? M.axis : 0);
        const svg = el("svg", { class: "chart", width: W, height: H, viewBox: `0 0 ${W} ${H}` }, panel);
        const g = { svg, top: M.top, h: ph, p };
        this.draw(g);
        if (last) this.drawXAxis(svg, M.top + ph + M.bottom);
        g.hl = el("rect", { class: "hl", y: M.top, height: ph, width: this.slotW, visibility: "hidden" }, svg);
        g.cross = el("line", { class: "cross", y1: M.top, y2: M.top + ph, visibility: "hidden" }, svg);
        const hit = el("rect", { class: "hit" + (o.onClick ? " click" : ""), x: M.left, y: 0, width: pw, height: H }, svg);
        hit.addEventListener("pointermove", e => this.onMove(e, svg));
        hit.addEventListener("pointerleave", () => this.clear());
        if (o.onClick) hit.addEventListener("click", e => { const i = this.indexAt(e, svg); if (i != null) o.onClick(i); });
        this.layers.push(g);
        this.root.appendChild(panel);
      });
      if (this.idx != null) this.highlight(this.idx);
    }

    x(i) { return M.left + (i + 0.5) * this.slotW; }

    yScale(g, lo, hi) {
      const ticks = niceTicks(lo, hi, g.p.ticks || 3);
      const a = ticks[0], b = ticks[ticks.length - 1];
      const y = v => g.top + g.h - ((v - a) / (b - a || 1)) * g.h;
      for (const t of ticks) {
        el("line", { class: t === a ? "base" : "grid", x1: M.left, x2: this.width - M.right, y1: y(t), y2: y(t) }, g.svg);
        el("text", { x: M.left - 6, y: y(t) + 4, "text-anchor": "end" }, g.svg).textContent = fmtTick(t);
      }
      return y;
    }

    extent(g, fns) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < this.o.n; i++) for (const f of fns) {
        const v = f(i);
        if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (g.p.yMin != null) lo = Math.min(lo, g.p.yMin);
      if (g.p.yMax != null) hi = Math.max(hi, g.p.yMax);
      if (g.p.zero) lo = Math.min(0, lo);
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      return [lo, hi];
    }

    draw(g) {
      const p = g.p, n = this.o.n;
      if (p.type === "strip") {
        const rows = p.rows, gap = 4, rh = (g.h - gap * (rows.length - 1)) / rows.length;
        rows.forEach((row, ri) => {
          const y = g.top + ri * (rh + gap);
          el("text", { x: M.left - 6, y: y + rh / 2 + 4, "text-anchor": "end" }, g.svg).textContent = row.label;
          let start = 0, cur = row.color(0);
          for (let i = 1; i <= n; i++) {
            const c = i < n ? row.color(i) : undefined;
            if (c !== cur) {
              if (cur) el("rect", { x: M.left + start * this.slotW, y, width: (i - start) * this.slotW, height: rh, fill: cur }, g.svg);
              start = i; cur = c;
            }
          }
        });
        return;
      }
      if (p.type === "line") {
        const fns = [p.value].concat(p.band || []);
        const [lo, hi] = this.extent(g, fns);
        const y = this.yScale(g, lo, hi);
        const maxGap = p.maxGap == null ? 3 : p.maxGap;
        if (p.band) {
          // min~max 띠: 연속 구간마다 다각형
          let run = [];
          const flush = () => {
            if (run.length > 1) {
              const top = run.map(i => `${this.x(i)},${y(p.band[1](i))}`), bot = run.slice().reverse().map(i => `${this.x(i)},${y(p.band[0](i))}`);
              el("polygon", { class: "band", points: top.concat(bot).join(" ") }, g.svg);
            }
            run = [];
          };
          for (let i = 0; i < n; i++) {
            if (p.band[0](i) == null || p.band[1](i) == null) flush(); else run.push(i);
          }
          flush();
        }
        if (p.area) {
          let run = [];
          const base = y(Math.max(lo, 0));
          const flush = () => {
            if (run.length) {
              const pts = run.map(i => `${this.x(i)},${y(p.value(i))}`);
              el("polygon", { class: "area", points: `${this.x(run[0])},${base} ${pts.join(" ")} ${this.x(run[run.length - 1])},${base}` }, g.svg);
            }
            run = [];
          };
          for (let i = 0; i < n; i++) { if (p.value(i) == null) flush(); else run.push(i); }
          flush();
        }
        // 선: maxGap 슬롯 이하의 빈칸은 잇고, 그보다 길면 끊는다
        let d = "", lastI = null, single = [];
        let segLen = 0;
        for (let i = 0; i < n; i++) {
          const v = p.value(i);
          if (v == null) continue;
          if (lastI == null || i - lastI > maxGap + 1) {
            if (segLen === 1) single.push(lastI);
            d += `M${this.x(i)},${y(v)}`; segLen = 1;
          } else { d += `L${this.x(i)},${y(v)}`; segLen++; }
          lastI = i;
        }
        if (segLen === 1) single.push(lastI);
        el("path", { class: "line", d }, g.svg);
        for (const i of single) el("circle", { cx: this.x(i), cy: y(p.value(i)), r: 1.5, fill: "var(--series)" }, g.svg);
        if (p.flag) for (let i = 0; i < n; i++) {
          if (p.flag(i) && p.value(i) != null) el("circle", { class: "flag", cx: this.x(i), cy: y(p.value(i)), r: 4 }, g.svg);
        }
        return;
      }
      if (p.type === "columns" || p.type === "stack") {
        const parts = p.type === "stack" ? p.parts : [{ value: p.value, color: p.color || "var(--series)" }];
        const total = i => parts.reduce((s, pt) => s + (pt.value(i) || 0), 0);
        const [lo, hi] = this.extent(g, [total]);
        const y = this.yScale(g, Math.min(0, lo), hi);
        const bw = Math.max(1, Math.min(24, this.slotW * 0.72));
        for (let i = 0; i < n; i++) {
          const x0 = this.x(i) - bw / 2;
          let acc = 0;
          const visible = parts.map(pt => pt.value(i) || 0);
          const topIdx = visible.map(v => v > 0).lastIndexOf(true);
          parts.forEach((pt, k) => {
            const v = visible[k];
            if (v <= 0) return;
            const y1 = y(acc), y2 = y(acc + v);
            acc += v;
            const gapPx = k > 0 && acc - v > 0 ? 2 : 0;   // 쌓인 조각 사이 2px 표면 간격
            const hgt = y1 - y2 - gapPx;
            if (hgt <= 0) return;
            el("path", { d: barPath(x0, y2, bw, hgt, k === topIdx ? Math.min(4, bw / 2) : 0), fill: pt.color }, g.svg);
          });
        }
      }
    }

    drawXAxis(svg, y0) {
      const ticks = this.o.xTicks || [];
      let lastX = -Infinity;
      for (const t of ticks) {
        const x = this.x(t.i);
        if (x - lastX < 54) continue;   // 겹치는 라벨은 생략
        el("text", { x, y: y0 + 14, "text-anchor": "middle" }, svg).textContent = t.label;
        lastX = x;
      }
    }

    indexAt(e, svg) {
      const r = svg.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - M.left) / this.slotW);
      return i >= 0 && i < this.o.n ? i : null;
    }

    onMove(e, svg) {
      const i = this.indexAt(e, svg);
      if (i == null) return this.clear();
      this.highlight(i);
      showTooltip(this.o.tooltip(i), e.clientX, e.clientY);
    }

    onKey(e) {
      const n = this.o.n;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = e.shiftKey ? 12 : 1;
        let i = this.idx == null ? (e.key === "ArrowRight" ? 0 : n - 1) : this.idx + (e.key === "ArrowRight" ? step : -step);
        i = Math.max(0, Math.min(n - 1, i));
        this.highlight(i);
        const svg = this.layers[0].svg.getBoundingClientRect();
        showTooltip(this.o.tooltip(i), svg.left + this.x(i), svg.top + 20);
      } else if (e.key === "Enter" && this.idx != null && this.o.onClick) {
        this.o.onClick(this.idx);
      } else if (e.key === "Escape") this.clear();
    }

    highlight(i) {
      this.idx = i;
      for (const g of this.layers) {
        const x = this.x(i);
        g.cross.setAttribute("x1", x); g.cross.setAttribute("x2", x);
        g.cross.setAttribute("visibility", "visible");
        if (g.p.type === "columns" || g.p.type === "stack") {
          g.hl.setAttribute("x", x - this.slotW / 2);
          g.hl.setAttribute("visibility", "visible");
          g.cross.setAttribute("visibility", "hidden");
        }
      }
    }

    clear() {
      this.idx = null;
      for (const g of this.layers) { g.cross.setAttribute("visibility", "hidden"); g.hl.setAttribute("visibility", "hidden"); }
      hideTooltip();
    }
  }

  // 카드용 스파크라인 (막대, 마지막 값만 강조색)
  function sparkBars(values, opts) {
    const W = opts.width || 220, H = opts.height || 36;
    const svg = el("svg", { class: "chart spark", width: "100%", height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    const max = opts.max || Math.max(1, ...values.filter(v => v != null));
    const slot = W / values.length, bw = Math.min(10, slot * 0.7);
    el("line", { class: "base", x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }, svg);
    values.forEach((v, i) => {
      if (v == null || v <= 0) return;
      const hgt = Math.max(1, (Math.min(v, max) / max) * (H - 2));
      el("path", {
        d: barPath(i * slot + (slot - bw) / 2, H - 1 - hgt, bw, hgt, 2),
        fill: i === values.length - 1 ? "var(--series)" : "var(--axis)",
      }, svg);
    });
    return svg;
  }

  window.Charts = { ChartGroup, sparkBars, hideTooltip };
})();

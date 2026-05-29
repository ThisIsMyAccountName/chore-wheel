/**
 * Chore Wheel Card
 * A carnival-style spinning wheel for Home Assistant that picks a chore
 * from a `todo` list entity. Spin → land on a chore → strike it off.
 *
 * No build step required. Drop into HA as a Lovelace resource.
 */

const CARD_VERSION = "1.2.0";

// Named colour families the user can pick from in the editor. `colors` (a
// custom hex list) still overrides whatever family is chosen.
const COLOR_FAMILIES = {
  // Six standard primary/secondary colours.
  classic: [
    "#e53935", "#1e88e5", "#fdd835", "#43a047", "#fb8c00", "#8e24aa",
  ],
  rainbow: [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
    "#dcbeff", "#9a6324", "#800000", "#aaffc3", "#808000",
  ],
  warm: [
    "#e6194b", "#f58231", "#ffd60a", "#d35400", "#c0392b",
    "#e67e22", "#f39c12", "#ff6b6b", "#ff8c42", "#cd6155",
  ],
  cool: [
    "#4363d8", "#3cb44b", "#42d4f4", "#469990", "#911eb4",
    "#1abc9c", "#2980b9", "#16a085", "#2ecc71", "#8e44ad",
  ],
  pastel: [
    "#ffd1dc", "#c1e1c1", "#bbcdf3", "#ffe5b4", "#e0bbe4",
    "#b5ead7", "#ffdac1", "#c7ceea", "#f8c8dc", "#d4f0f0",
  ],
  earth: [
    "#8d6e63", "#a1887f", "#827717", "#6d4c41", "#9e9d24",
    "#5d4037", "#bcaaa4", "#33691e", "#795548", "#c0a16b",
  ],
};

const DEFAULT_PALETTE = COLOR_FAMILIES.rainbow;

const mod2pi = (a) => {
  const t = 2 * Math.PI;
  return ((a % t) + t) % t;
};

/**
 * Returns an easing function for the given cubic-bezier control points
 * (same maths the browser uses for CSS `cubic-bezier`). Solved with
 * Newton-Raphson, good enough for animation.
 */
const cubicBezier = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-6) break;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return Math.max(0, Math.min(1, t));
  };
  return (x) => sampleY(solveX(x));
};

// Gentle inertia ramp at the start, long slow settle at the end → suspense.
const SPIN_EASE = cubicBezier(0.2, 0.0, 0.08, 1.0);

class ChoreWheelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._items = [];        // raw todo items from the websocket
    this._segments = [];     // {name, uid, color} drawn on the wheel
    this._rotation = 0;      // current wheel rotation (radians)
    this._spinning = false;
    this._needsRefresh = false;
    this._lastStamp = null;
    this._winner = null;     // currently displayed result segment
    this._size = 320;
    this._domReady = false;
    this._colorMap = {};     // uid -> color, stable across removals
    this._confetti = [];
    this._confAnim = null;
    this._listNames = new Set(); // lowercased summaries currently on the list
  }

  /* ------------------------------------------------------------------ */
  /* Lovelace plumbing                                                  */
  /* ------------------------------------------------------------------ */

  static getConfigElement() {
    return document.createElement("chore-wheel-card-editor");
  }

  static getStubConfig(hass) {
    let entity = "todo.chores";
    if (hass) {
      const todo = Object.keys(hass.states).find((e) => e.startsWith("todo."));
      if (todo) entity = todo;
    }
    return { entity, title: "Chore Wheel", spin_duration: 5 };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("You must define a `todo` entity");
    }
    if (!config.entity.startsWith("todo.")) {
      throw new Error("`entity` must be a todo list (todo.*)");
    }
    this._config = {
      title: "Chore Wheel",
      spin_duration: 5,
      strike_action: "complete", // "complete" | "remove"
      show_completed: false,
      color_family: "rainbow",   // a key of COLOR_FAMILIES
      colors: null,              // custom hex list; overrides color_family
      quick_chores: [],          // labels offered as one-tap "add to list" chips
      ...config,
    };
    this._colorMap = {};        // palette may have changed → recompute colours
    this._lastStamp = null;     // force a refetch
    if (this._domReady) {
      this._titleEl.textContent = this._config.title || "";
      this._renderQuickAdd();
      this._clearResult();
      this._draw();
    }
  }

  getCardSize() {
    return 8;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._ensureDom();

    const st = hass.states[this._config.entity];
    if (!st) {
      this._showError(`Entity not found: ${this._config.entity}`);
      return;
    }
    this._hideError();

    // Re-fetch items only when the list actually changed.
    if (st.last_updated !== this._lastStamp) {
      this._lastStamp = st.last_updated;
      this._fetchItems();
    }
  }

  connectedCallback() {
    this._ensureDom();
    if (this._ro) this._ro.observe(this._wrap);
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._confAnim) cancelAnimationFrame(this._confAnim);
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */

  _ensureDom() {
    if (this._domReady) return;

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      ha-card {
        padding: 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .title {
        font-size: 1.4em;
        font-weight: 600;
        text-align: center;
        width: 100%;
      }
      .wrap {
        position: relative;
        width: 100%;
        max-width: 420px;
        aspect-ratio: 1 / 1;
      }
      canvas.wheel { width: 100%; height: 100%; display: block; cursor: pointer; }
      canvas.confetti {
        position: absolute;
        inset: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 3;
      }
      .pointer {
        position: absolute;
        top: 50%; right: -4px;
        transform: translateY(-50%);
        width: 0; height: 0;
        border-top: 16px solid transparent;
        border-bottom: 16px solid transparent;
        border-right: 28px solid var(--error-color, #d32f2f);
        filter: drop-shadow(0 2px 2px rgba(0,0,0,.4));
        z-index: 2;
        pointer-events: none;
      }
      .spin-btn {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
        border: none;
        border-radius: 999px;
        padding: 12px 32px;
        font-size: 1.1em;
        font-weight: 600;
        cursor: pointer;
        transition: transform .08s ease, opacity .2s ease;
      }
      .spin-btn:hover:not(:disabled) { transform: scale(1.04); }
      .spin-btn:disabled { opacity: .5; cursor: default; }
      .quick-add {
        display: none;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        width: 100%;
      }
      .chip {
        background: var(--secondary-background-color, #f1f1f1);
        color: var(--primary-text-color, #333);
        border: 1px solid var(--divider-color, rgba(0,0,0,.12));
        border-radius: 999px;
        padding: 6px 14px;
        font-size: .95em;
        font-weight: 500;
        cursor: pointer;
        transition: transform .08s ease, filter .2s ease;
      }
      .chip:hover:not(:disabled) { filter: brightness(.95); transform: scale(1.04); }
      .chip:disabled { opacity: .5; cursor: default; }
      .result {
        width: 100%;
        text-align: center;
        min-height: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 14px;
        border-radius: 12px;
        background: var(--secondary-background-color, #f1f1f1);
        box-sizing: border-box;
        animation: pop .25s ease;
      }
      .result.show { display: flex; }
      @keyframes pop { from { transform: scale(.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .result .label { font-size: .85em; color: var(--secondary-text-color); letter-spacing: .04em; text-transform: uppercase; }
      .result .chore { font-size: 1.6em; font-weight: 700; line-height: 1.2; }
      .done-btn {
        background: var(--success-color, #43a047);
        color: #fff;
        border: none;
        border-radius: 999px;
        padding: 10px 24px;
        font-size: 1em;
        font-weight: 600;
        cursor: pointer;
      }
      .done-btn:hover { filter: brightness(1.08); }
      .error {
        display: none;
        color: var(--error-color, #d32f2f);
        text-align: center;
        font-weight: 500;
      }
      .error.show { display: block; }
      .empty { color: var(--secondary-text-color); text-align: center; }
      .manage-btn {
        display: none;
        background: transparent;
        color: var(--secondary-text-color);
        border: none;
        cursor: pointer;
        font-size: .9em;
        text-decoration: underline;
        padding: 2px 6px;
      }
      .manage {
        display: none;
        flex-direction: column;
        gap: 6px;
        width: 100%;
        max-width: 420px;
      }
      .manage.show { display: flex; }
      .manage-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px 6px 14px;
        border-radius: 8px;
        background: var(--secondary-background-color, #f1f1f1);
      }
      .manage-row .name {
        flex: 1;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .del-btn {
        background: transparent;
        border: none;
        color: var(--error-color, #d32f2f);
        cursor: pointer;
        font-size: 1.2em;
        line-height: 1;
        padding: 2px 8px;
        border-radius: 6px;
      }
      .del-btn:hover:not(:disabled) { background: rgba(0,0,0,.08); }
      .del-btn:disabled { opacity: .5; cursor: default; }
    `;

    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="title"></div>
      <div class="error"></div>
      <div class="wrap">
        <div class="pointer"></div>
        <canvas class="wheel"></canvas>
        <canvas class="confetti"></canvas>
      </div>
      <button class="spin-btn" type="button">Spin the wheel</button>
      <div class="quick-add"></div>
      <div class="result">
        <div class="label">Your chore is</div>
        <div class="chore"></div>
        <button class="done-btn" type="button">✓ Mark done</button>
      </div>
      <button class="manage-btn" type="button">Manage chores</button>
      <div class="manage"></div>
    `;

    this.shadowRoot.append(style, card);

    this._titleEl = card.querySelector(".title");
    this._errorEl = card.querySelector(".error");
    this._wrap = card.querySelector(".wrap");
    this._canvas = card.querySelector("canvas.wheel");
    this._ctx = this._canvas.getContext("2d");
    this._confCanvas = card.querySelector("canvas.confetti");
    this._confCtx = this._confCanvas.getContext("2d");
    this._spinBtn = card.querySelector(".spin-btn");
    this._quickAddEl = card.querySelector(".quick-add");
    this._resultEl = card.querySelector(".result");
    this._choreEl = card.querySelector(".chore");
    this._doneBtn = card.querySelector(".done-btn");
    this._manageBtn = card.querySelector(".manage-btn");
    this._manageEl = card.querySelector(".manage");

    this._titleEl.textContent = this._config?.title || "";

    this._spinBtn.addEventListener("click", () => this._spin());
    this._canvas.addEventListener("click", () => this._spin());
    this._doneBtn.addEventListener("click", () => this._strike());
    this._manageBtn.addEventListener("click", () => {
      this._manageEl.classList.toggle("show");
    });

    this._ro = new ResizeObserver(() => this._resize());
    this._domReady = true;
    this._renderQuickAdd();
    this._renderManage();
    this._resize();
  }

  _showError(msg) {
    this._ensureDom();
    this._errorEl.textContent = msg;
    this._errorEl.classList.add("show");
  }

  _hideError() {
    if (this._errorEl) this._errorEl.classList.remove("show");
  }

  /* ------------------------------------------------------------------ */
  /* Data                                                               */
  /* ------------------------------------------------------------------ */

  async _fetchItems() {
    if (!this._hass || !this._config) return;
    try {
      const res = await this._hass.callWS({
        type: "todo/item/list",
        entity_id: this._config.entity,
      });
      const items = (res && res.items) || [];
      // Track every summary on the list (completed or not) so quick-add chips
      // can be disabled for chores that already exist.
      this._listNames = new Set(
        items
          .map((i) => String(i.summary || "").trim().toLowerCase())
          .filter(Boolean)
      );
      this._items = this._config.show_completed
        ? items
        : items.filter((i) => i.status !== "completed");
      this._buildSegments();
      this._updateQuickAddState();
    } catch (err) {
      this._showError(`Could not load items: ${err.message || err}`);
    }
  }

  _buildSegments() {
    if (this._spinning) {
      this._needsRefresh = true;
      return;
    }
    const palette = this._palette();
    const n = this._items.length;
    const segs = [];
    for (let i = 0; i < n; i++) {
      const it = this._items[i];
      const uid = it.uid || it.summary;
      // Keep an already-assigned colour so an existing chore never changes
      // colour (and removing one never reshuffles the rest).
      let color = this._colorMap[uid];
      if (!color) {
        // Avoid the previous slice's colour, and for the last slice the
        // wrap-around first slice too, so a freshly added chore doesn't land
        // next to a matching colour.
        const avoid = new Set();
        if (segs.length) avoid.add(segs[segs.length - 1].color);
        if (i === n - 1 && segs.length) avoid.add(segs[0].color);
        color = this._pickColor(palette, segs, avoid);
        this._colorMap[uid] = color;
      }
      segs.push({ name: it.summary || "(untitled)", uid, color });
    }
    this._segments = segs;

    // If the displayed winner is gone, clear it.
    if (this._winner && !this._segments.some((s) => s.uid === this._winner.uid)) {
      this._clearResult();
    }
    this._renderManage();
    this._draw();
  }

  /* ------------------------------------------------------------------ */
  /* Quick-add chores                                                   */
  /* ------------------------------------------------------------------ */

  // Build one chip per configured quick chore. Tapping a chip adds that
  // chore to the todo list so it lands on the wheel right away.
  _renderQuickAdd() {
    if (!this._quickAddEl) return;
    const chores = Array.isArray(this._config?.quick_chores)
      ? this._config.quick_chores.filter((c) => c && String(c).trim())
      : [];
    this._quickAddEl.textContent = "";
    if (!chores.length) {
      this._quickAddEl.style.display = "none";
      return;
    }
    this._quickAddEl.style.display = "flex";
    for (const name of chores) {
      const label = String(name).trim();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.chore = label.toLowerCase();
      btn.textContent = `+ ${label}`;
      btn.addEventListener("click", () => this._quickAdd(label, btn));
      this._quickAddEl.appendChild(btn);
    }
    this._updateQuickAddState();
  }

  // Grey out the chip for any chore already on the list (case-insensitive),
  // so the same chore can't be added twice.
  _updateQuickAddState() {
    if (!this._quickAddEl) return;
    for (const btn of this._quickAddEl.children) {
      const inList = this._listNames.has(btn.dataset.chore);
      btn.disabled = inList;
      btn.title = inList ? "Already on the list" : "";
    }
  }

  async _quickAdd(name, btn) {
    if (!this._hass || !this._config) return;
    // Don't add a chore that's already on the list (case-insensitive).
    if (this._listNames.has(name.trim().toLowerCase())) {
      this._updateQuickAddState();
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await this._hass.callService(
        "todo",
        "add_item",
        { item: name },
        { entity_id: this._config.entity }
      );
      await this._fetchItems(); // last_updated will also trigger, but be eager
    } catch (err) {
      this._showError(`Could not add item: ${err.message || err}`);
    } finally {
      this._updateQuickAddState();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Manage / remove chores                                             */
  /* ------------------------------------------------------------------ */

  // List the current chores with a remove (✕) button each.
  _renderManage() {
    if (!this._manageEl || !this._manageBtn) return;
    const segs = this._segments;
    this._manageEl.textContent = "";
    if (!segs.length) {
      this._manageBtn.style.display = "none";
      this._manageEl.classList.remove("show");
      return;
    }
    this._manageBtn.style.display = "block";
    for (const seg of segs) {
      const row = document.createElement("div");
      row.className = "manage-row";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = seg.name;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = "✕";
      del.title = `Remove "${seg.name}"`;
      del.setAttribute("aria-label", `Remove ${seg.name}`);
      del.addEventListener("click", () => this._removeItem(seg.uid, del));

      row.append(name, del);
      this._manageEl.appendChild(row);
    }
  }

  async _removeItem(uid, btn) {
    if (!this._hass || !this._config || !uid) return;
    if (btn) btn.disabled = true;
    try {
      await this._hass.callService(
        "todo",
        "remove_item",
        { item: uid },
        { entity_id: this._config.entity }
      );
      if (this._winner && this._winner.uid === uid) this._clearResult();
      await this._fetchItems(); // last_updated will also trigger, but be eager
    } catch (err) {
      this._showError(`Could not remove item: ${err.message || err}`);
      if (btn) btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  _resize() {
    if (!this._domReady) return;
    const w = this._wrap.clientWidth || 320;
    this._size = w;
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = Math.round(w * dpr);
    this._canvas.height = Math.round(w * dpr);
    this._confCanvas.width = Math.round(w * dpr);
    this._confCanvas.height = Math.round(w * dpr);
    this._draw();
  }

  _draw() {
    if (!this._domReady) return;
    const ctx = this._ctx;
    const size = this._size;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const n = this._segments.length;

    // Outer rim
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    if (n === 0) {
      ctx.fillStyle = getComputedStyle(this).getPropertyValue("--secondary-text-color") || "#888";
      ctx.font = `${Math.max(14, size * 0.045)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No chores left 🎉", cx, cy);
      this._spinBtn.disabled = true;
      return;
    }
    this._spinBtn.disabled = this._spinning;

    const segAngle = (2 * Math.PI) / n;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._rotation);

    for (let i = 0; i < n; i++) {
      const start = i * segAngle;
      const end = start + segAngle;
      const seg = this._segments[i];

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, start, end);
      ctx.closePath();
      ctx.fillStyle = seg.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();

      // Label
      ctx.save();
      ctx.rotate(start + segAngle / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this._contrastColor(seg.color);
      const fontSize = Math.max(11, Math.min(20, (r * 0.9 * segAngle) * 0.6, size * 0.05));
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.fillText(this._truncate(seg.name, r * 0.7, ctx), r - 14, 0);
      ctx.restore();
    }
    ctx.restore();

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(22, r * 0.16), 0, 2 * Math.PI);
    ctx.fillStyle = getComputedStyle(this).getPropertyValue("--card-background-color") || "#fff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.stroke();
    ctx.fillStyle = getComputedStyle(this).getPropertyValue("--primary-text-color") || "#333";
    ctx.font = `700 ${Math.max(11, r * 0.07)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this._spinning ? "…" : "SPIN", cx, cy);
  }

  _truncate(text, maxWidth, ctx) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
      t = t.slice(0, -1);
    }
    return t + "…";
  }

  // Active segment palette: an explicit `colors` list wins, otherwise the
  // chosen `color_family`, falling back to the rainbow default.
  _palette() {
    if (this._config.colors && this._config.colors.length) return this._config.colors;
    return COLOR_FAMILIES[this._config.color_family] || DEFAULT_PALETTE;
  }

  // Pick a colour for a new slice: the least-used palette colour, preferring
  // one that isn't an adjacent neighbour. This cycles the palette evenly so
  // colours never clump, and gracefully relaxes the neighbour rule when the
  // palette is too small to honour it.
  _pickColor(palette, segs, avoid) {
    const counts = new Map(palette.map((c) => [c, 0]));
    for (const s of segs) {
      if (counts.has(s.color)) counts.set(s.color, counts.get(s.color) + 1);
    }
    const leastUsed = (skip) => {
      let best = null;
      let bestN = Infinity;
      for (const c of palette) {
        if (skip && skip.has(c)) continue;
        const used = counts.get(c) || 0;
        if (used < bestN) {
          bestN = used;
          best = c;
        }
      }
      return best;
    };
    return leastUsed(avoid) || leastUsed(null) || palette[0];
  }

  _contrastColor(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return "#fff";
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    // Relative luminance
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#222" : "#fff";
  }

  /* ------------------------------------------------------------------ */
  /* Spin                                                               */
  /* ------------------------------------------------------------------ */

  _spin() {
    if (this._spinning) return;
    const n = this._segments.length;
    if (n === 0) return;

    this._clearResult();

    if (n === 1) {
      this._setResult(this._segments[0]);
      this._burstConfetti();
      return;
    }

    this._spinning = true;
    this._spinBtn.disabled = true;

    // 5–7 full turns plus a uniformly random landing angle — the wheel can
    // stop anywhere, including near a slice edge, instead of being snapped to
    // a slice centre. The easing does the rest of the suspense.
    const spins = 5 + Math.floor(Math.random() * 3);
    const extra = Math.random() * 2 * Math.PI;
    const totalDelta = spins * 2 * Math.PI + extra;

    const start = this._rotation;
    const duration = Math.max(1, this._config.spin_duration || 5) * 1000;
    const t0 = performance.now();

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      this._rotation = start + totalDelta * SPIN_EASE(t);
      this._draw();
      if (t < 1) {
        this._raf = requestAnimationFrame(step);
      } else {
        this._rotation = mod2pi(start + totalDelta);
        this._spinning = false;
        this._draw();
        this._setResult(this._segments[this._winnerAt(this._rotation)]);
        this._burstConfetti();
        if (this._needsRefresh) {
          this._needsRefresh = false;
          this._buildSegments();
        }
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  // Which slice sits under the pointer (right edge, angle 0) at this rotation.
  _winnerAt(rot) {
    const n = this._segments.length;
    const segAngle = (2 * Math.PI) / n;
    const local = mod2pi(0 - rot); // pointer is at canvas angle 0 (3 o'clock)
    return Math.floor(local / segAngle) % n;
  }

  /* ------------------------------------------------------------------ */
  /* Confetti                                                           */
  /* ------------------------------------------------------------------ */

  _burstConfetti() {
    const palette = this._palette();
    const size = this._size;
    const cx = size / 2;
    const cy = size / 2;
    const count = 90;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * 2 * Math.PI;
      const speed = 2 + Math.random() * 7;
      this._confetti.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 3, // slight upward bias
        size: 4 + Math.random() * 6,
        color: palette[Math.floor(Math.random() * palette.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.35,
        life: 1,
      });
    }
    if (!this._confAnim) this._animateConfetti();
  }

  _animateConfetti() {
    const ctx = this._confCtx;
    const size = this._size;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const gravity = 0.16;
    let alive = false;
    for (const p of this._confetti) {
      if (p.life <= 0) continue;
      p.vy += gravity;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.012;
      if (p.life > 0 && p.y < size + 30) alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    if (alive) {
      this._confAnim = requestAnimationFrame(() => this._animateConfetti());
    } else {
      this._confAnim = null;
      this._confetti = [];
      ctx.clearRect(0, 0, size, size);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Result + strike                                                    */
  /* ------------------------------------------------------------------ */

  _setResult(seg) {
    this._winner = seg;
    this._choreEl.textContent = seg.name;
    this._resultEl.classList.add("show");
  }

  _clearResult() {
    this._winner = null;
    if (this._resultEl) this._resultEl.classList.remove("show");
  }

  async _strike() {
    if (!this._winner || !this._hass) return;
    const seg = this._winner;
    this._doneBtn.disabled = true;
    const service = this._config.strike_action === "remove" ? "remove_item" : "update_item";
    const data = { item: seg.uid };
    if (service === "update_item") data.status = "completed";
    try {
      await this._hass.callService("todo", service, data, {
        entity_id: this._config.entity,
      });
      this._clearResult();
      await this._fetchItems(); // last_updated will also trigger, but be eager
    } catch (err) {
      this._showError(`Could not update item: ${err.message || err}`);
    } finally {
      this._doneBtn.disabled = false;
    }
  }
}

customElements.define("chore-wheel-card", ChoreWheelCard);

/* -------------------------------------------------------------------- */
/* Visual editor                                                        */
/* -------------------------------------------------------------------- */

class ChoreWheelCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (this._form) {
      this._form.data = this._toFormData(this._config);
      return;
    }
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "entity", required: true, selector: { entity: { domain: "todo" } } },
      { name: "title", selector: { text: {} } },
      {
        name: "spin_duration",
        selector: { number: { min: 1, max: 20, step: 1, mode: "slider", unit_of_measurement: "s" } },
      },
      {
        name: "strike_action",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "complete", label: "Mark item completed" },
              { value: "remove", label: "Remove item from list" },
            ],
          },
        },
      },
      { name: "show_completed", selector: { boolean: {} } },
      {
        name: "color_family",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "classic", label: "Classic" },
              { value: "rainbow", label: "Rainbow" },
              { value: "warm", label: "Warm" },
              { value: "cool", label: "Cool" },
              { value: "pastel", label: "Pastel" },
              { value: "earth", label: "Earth" },
            ],
          },
        },
      },
      // One chore per line. A multiline text field keeps focus across the
      // form's re-renders; the `multiple` text selector recreates its inputs
      // on every keystroke and steals focus, so we convert lines <-> array.
      { name: "quick_chores", selector: { text: { multiline: true } } },
    ];
    this._form.computeLabel = (s) => {
      const labels = {
        entity: "Todo list (chores)",
        title: "Title",
        spin_duration: "Spin duration",
        strike_action: "When marked done",
        show_completed: "Show completed chores too",
        color_family: "Colour family",
        quick_chores: "Quick-add chores",
      };
      return labels[s.name] || s.name;
    };
    this._form.computeHelper = (s) =>
      s.name === "quick_chores" ? "One chore per line" : undefined;
    this._form.data = this._toFormData(this._config);
    if (this._hass) this._form.hass = this._hass;
    this._form.addEventListener("value-changed", (ev) => {
      const value = { ...ev.detail.value };
      if (typeof value.quick_chores === "string") {
        value.quick_chores = value.quick_chores
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean);
      }
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: value },
          bubbles: true,
          composed: true,
        })
      );
    });
    this.appendChild(this._form);
  }

  // The form edits quick_chores as a newline-joined string; everything else
  // passes through unchanged.
  _toFormData(config) {
    const chores = Array.isArray(config?.quick_chores) ? config.quick_chores : [];
    return { ...config, quick_chores: chores.join("\n") };
  }
}

customElements.define("chore-wheel-card-editor", ChoreWheelCardEditor);

/* -------------------------------------------------------------------- */
/* Card picker registration                                             */
/* -------------------------------------------------------------------- */

window.customCards = window.customCards || [];
window.customCards.push({
  type: "chore-wheel-card",
  name: "Chore Wheel Card",
  description: "A spinning carnival wheel that picks a chore from a todo list.",
  preview: false,
  documentationURL: "https://github.com/ThisIsMyAccountName/chore-wheel",
});

console.info(
  `%c CHORE-WHEEL-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#03a9f4;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px;",
  "color:#03a9f4;background:#fff;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px;"
);

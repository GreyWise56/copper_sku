/**
 * Browser-side controller.
 *
 * Wires the design's DOM (matching IDs/classes) to the engine from
 * `src/lib/sku.ts` + `src/lib/constraints.ts`. Ported from the v4 HTML's
 * monolithic <script> block, split into self-contained functions and
 * adapted to use the design's modern class set (`.token`, `.acc-item`,
 * `.finish-chip` etc. for workbench; `.base-tile`, `.finish-tile` etc.
 * for showroom).
 *
 * Same rules. Same constraints. Same CAT order. Same companion behavior,
 * with EE companion now showing ALL CEILING MOUNT options (spec §16b).
 */
import { DATA } from "./data";
import { emptyState, type State, type GeneratedSku } from "./types";
import {
  activeTriggers,
  getActiveMountCategory,
  isAccessoryExcluded,
  isCategoryHiddenByCompanion,
  isMountCategoryDisabled,
  pickedInCategory,
  resolveCompanionOptions,
} from "./constraints";
import { displayCode, generate } from "./sku";
import { decodeState, encodeState } from "./permalink";

export type ControllerIds = {
  parentSel: string;
  baseGrid: string;
  finishGrid: string;
  finishAside: string;
  brassNote: string;
  accessoriesWrap: string;
  steps: string[];
  skuCount: string;
  skuPath?: string;
  skuList: string;
  skuEmpty: string;
  searchInput?: string;
  sortSelect?: string;
  copyAllBtn: string;
  exportBtn: string;
  shareBtn?: string;
  resetBtn: string;
  toast?: string;
};

export type ControllerClasses = {
  on?: string;
  disabled?: string;
  baseTile: string;
  finishTile: string;
  accItem: string;
  biltmoreBanner?: string;
  accGroup: string;
  accGroupHead: string;
  accGrid: string;
};

const DOT_CLASS: Record<string, string> = {
  GAS: "dot-gas",
  ELECTRIC: "dot-electric",
  "WALL MOUNT": "dot-wall",
  "WALL MOUNT ACCESSORIES": "dot-wall",
  "CEILING MOUNT": "dot-ceil",
  "POST & PIER MOUNT": "dot-post",
  "DECORATIVE OPTIONS": "dot-dec",
  PARTS: "dot-parts",
};

export function initController(opts: {
  ids: ControllerIds;
  classes: ControllerClasses;
}): void {
  const { ids, classes } = opts;
  const ON = classes.on || "on";
  const DISABLED = classes.disabled || "disabled";

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const parentSel = $<HTMLSelectElement>(ids.parentSel);
  if (!parentSel) return;

  let state: State = emptyState();
  let currentRows: GeneratedSku[] = [];
  let suppressHash = false;

  // ── Build the family dropdown ───────────────────────────────────────
  function buildParentDropdown() {
    if (!parentSel) return;
    const entries = Object.entries(DATA.families).map(([k, v]) => ({
      key: k,
      label: v.label,
      ignition: v.ignition,
      isBilt: v.isBiltmore,
    }));
    entries.sort((a, b) => {
      if (a.isBilt !== b.isBilt) return a.isBilt ? 1 : -1;
      if (a.label !== b.label) return a.label.localeCompare(b.label);
      return a.ignition.localeCompare(b.ignition);
    });
    let lastGroup: string | null = null;
    let currentOG: HTMLOptGroupElement | null = null;
    for (const e of entries) {
      const group = e.isBilt ? "— Biltmore® —" : "— Standard Collections —";
      if (group !== lastGroup) {
        currentOG = document.createElement("optgroup");
        currentOG.label = group;
        parentSel.appendChild(currentOG);
        lastGroup = group;
      }
      const o = document.createElement("option");
      o.value = e.key;
      o.textContent = `${e.label} — ${e.ignition} (${e.key})`;
      currentOG!.appendChild(o);
    }
  }

  // ── Finish swatches ─────────────────────────────────────────────────
  function buildFinishGrid() {
    const g = $(ids.finishGrid);
    if (!g) return;
    g.innerHTML = "";
    for (const f of DATA.finishes) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = classes.finishTile;
      tile.dataset.code = f.code;
      const isClear = f.code === "CLEAR";
      tile.innerHTML = `
        <span class="finish-swatch" style="background:${f.color}${
          isClear ? ";box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)" : ""
        }"></span>
        <span class="finish-meta">
          <span class="finish-name">${f.name}</span>
          <span class="finish-code">${f.code || "default"}</span>
        </span>
        ${!f.code ? '<span class="finish-default">DEFAULT</span>' : ""}
      `;
      tile.addEventListener("click", () => {
        toggleArr(state.finishes, f.code);
        tile.classList.toggle(ON);
        regenerate();
      });
      g.appendChild(tile);
    }
  }

  function applyFinishMode(brassOnly: boolean) {
    const grid = $(ids.finishGrid);
    const note = $(ids.brassNote);
    const aside = $(ids.finishAside);
    if (brassOnly) {
      if (grid) grid.style.display = "none";
      if (note) note.style.display = "";
      if (aside) aside.textContent = "brass only · finish suffix omitted";
      state.finishes = [];
      grid?.querySelectorAll(`.${classes.finishTile}`).forEach((el) =>
        el.classList.remove(ON),
      );
    } else {
      if (grid) grid.style.display = "";
      if (note) note.style.display = "none";
      if (aside) aside.textContent = "default · Antique Copper (no suffix)";
    }
  }

  function toggleArr<T>(arr: T[], val: T): void {
    const i = arr.indexOf(val);
    if (i > -1) arr.splice(i, 1);
    else arr.push(val);
  }

  // ── Section enable/disable ──────────────────────────────────────────
  function setStepEnabled(stepIdx: number, on: boolean) {
    const step = $(ids.steps[stepIdx]);
    if (!step) return;
    step.classList.toggle(DISABLED, !on);
  }

  // ── Family change ──────────────────────────────────────────────────
  function onParentChange() {
    if (!parentSel) return;
    state = { ...emptyState(), parent: parentSel.value };
    if (!state.parent) {
      setStepEnabled(1, false);
      setStepEnabled(2, false);
      setStepEnabled(3, false);
      const sg = $(ids.baseGrid);
      if (sg) sg.innerHTML = "";
      const aw = $(ids.accessoriesWrap);
      if (aw)
        aw.innerHTML =
          '<div class="empty-notice">Select a product family and at least one base SKU to see compatible accessories.</div>';
      applyFinishMode(false);
      regenerate();
      pushHash();
      return;
    }
    const fam = DATA.families[state.parent];
    const sg = $(ids.baseGrid);
    if (sg) {
      sg.innerHTML = "";
      for (const b of fam.baseSkus) {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = classes.baseTile;
        tile.dataset.value = b.sku;
        tile.innerHTML = `
          <span class="check"></span>
          <span class="b-label">${b.sizeLabel}</span>
          <span class="b-code">${b.sku}</span>
        `;
        tile.addEventListener("click", () => {
          toggleArr(state.baseSkus, b.sku);
          tile.classList.toggle(ON);
          renderAccessories();
          regenerate();
        });
        sg.appendChild(tile);
      }
    }
    const aw = $(ids.accessoriesWrap);
    if (aw)
      aw.innerHTML =
        '<div class="empty-notice">Select at least one base SKU above to see compatible accessories.</div>';
    applyFinishMode(!!fam.brassOnly);
    setStepEnabled(1, true);
    setStepEnabled(2, true);
    setStepEnabled(3, true);
    regenerate();
    pushHash();
  }

  parentSel.addEventListener("change", onParentChange);

  // ── Accessory panel rendering ───────────────────────────────────────
  function renderAccessories() {
    const wrap = $(ids.accessoriesWrap);
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!state.parent || !state.baseSkus.length) {
      state.accessories = {};
      state.companions = {};
      wrap.innerHTML =
        '<div class="empty-notice">Select at least one base SKU above to see compatible accessories.</div>';
      return;
    }
    const fam = DATA.families[state.parent];
    if (fam.isBiltmore && classes.biltmoreBanner) {
      const banner = document.createElement("div");
      banner.className = classes.biltmoreBanner;
      banner.innerHTML =
        "<strong>Biltmore® line:</strong> uses dedicated Biltmore® mount hardware (BMTS, BMCM, BMPF, BMPM, BMY, BMCHM, BMSM, BMCPM). Standard wall / hook & scroll mounts do not apply here.";
      wrap.appendChild(banner);
    }
    const activeMount = getActiveMountCategory(DATA, state);
    let renderedAny = false;

    for (const cat of DATA.categoryOrder) {
      if (!fam.accessoryGrid[cat]) continue;
      if (isCategoryHiddenByCompanion(DATA, state, cat)) continue;

      let opts = fam.accessoryGrid[cat].filter((opt) =>
        state.baseSkus.every((sku) => opt.codes[sku] !== undefined),
      );
      opts = opts.filter(
        (opt) =>
          !opt.excludedByIgnition ||
          !opt.excludedByIgnition.includes(fam.ignition),
      );
      if (!opts.length) continue;
      renderedAny = true;

      const panel = document.createElement("div");
      panel.className = classes.accGroup;
      const muted = isMountCategoryDisabled(DATA, state, cat);
      if (muted) panel.style.opacity = "0.45";

      const hdr = document.createElement("div");
      hdr.className = classes.accGroupHead;
      const dot = DOT_CLASS[cat] || "dot-parts";
      hdr.innerHTML = `<span class="dot ${dot}"></span><span class="gtitle">${humanCat(
        cat,
      )}</span><span class="gcount">${opts.length} option${
        opts.length === 1 ? "" : "s"
      }</span>`;
      if (muted) {
        const note = document.createElement("span");
        note.style.cssText =
          "font-family:'Inter',sans-serif;font-size:11px;color:var(--ink-3);font-style:italic;margin-left:auto;";
        note.textContent = `unavailable while ${humanCat(activeMount!)} is selected`;
        hdr.appendChild(note);
      }
      panel.appendChild(hdr);

      const grid = document.createElement("div");
      grid.className = classes.accGrid;
      for (const opt of opts) {
        const code = displayCode(opt, state.baseSkus);
        const conflictDisabled = isAccessoryExcluded(DATA, state, fam, opt);
        const item = document.createElement("button");
        item.type = "button";
        item.className = classes.accItem;
        if (muted || conflictDisabled) {
          item.style.opacity = "0.32";
          item.style.pointerEvents = "none";
        }
        item.innerHTML = `<span class="a-label">${opt.name}</span><span class="a-code">${code}</span>`;
        if ((state.accessories[cat] || []).includes(opt.name))
          item.classList.add(ON);
        item.addEventListener("click", () => {
          if (!state.accessories[cat]) state.accessories[cat] = [];
          toggleArr(state.accessories[cat], opt.name);
          if (opt.triggersCompanion && !state.accessories[cat].includes(opt.name)) {
            delete state.companions[opt.name];
          }
          renderAccessories();
          regenerate();
        });
        grid.appendChild(item);
      }
      panel.appendChild(grid);
      wrap.appendChild(panel);

      // Companion sub-panels for triggers selected in THIS category
      for (const pickName of state.accessories[cat] || []) {
        const rule = DATA.companionRules[pickName];
        if (!rule) continue;
        const companions = resolveCompanionOptions(rule, fam, state.baseSkus);
        const ePanel = document.createElement("div");
        ePanel.className = classes.accGroup;
        ePanel.style.cssText +=
          "border-left:3px solid var(--copper);background:var(--copper-soft);";
        const titleEl = document.createElement("div");
        titleEl.style.cssText =
          "font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:500;color:var(--ink);margin-bottom:4px;";
        titleEl.textContent = rule.panelTitle;
        ePanel.appendChild(titleEl);
        const noteEl = document.createElement("div");
        noteEl.style.cssText =
          "font-size:12.5px;color:var(--ink-2);font-style:italic;margin-bottom:10px;line-height:1.5;";
        noteEl.textContent = rule.panelNote;
        ePanel.appendChild(noteEl);

        if (!companions.length) {
          const emptyNote = document.createElement("div");
          emptyNote.className = "empty-notice";
          emptyNote.textContent =
            "No compatible companions available for selected base SKU(s).";
          ePanel.appendChild(emptyNote);
        } else {
          const cgrid = document.createElement("div");
          cgrid.className = classes.accGrid;
          for (const o of companions) {
            const code = displayCode(o, state.baseSkus);
            const item = document.createElement("button");
            item.type = "button";
            item.className = classes.accItem;
            item.innerHTML = `<span class="a-label">${o.name}</span><span class="a-code">${code}</span>`;
            if ((state.companions[pickName] || []).includes(o.name))
              item.classList.add(ON);
            item.addEventListener("click", () => {
              if (!state.companions[pickName])
                state.companions[pickName] = [];
              toggleArr(state.companions[pickName], o.name);
              item.classList.toggle(ON);
              regenerate();
            });
            cgrid.appendChild(item);
          }
          ePanel.appendChild(cgrid);
        }
        wrap.appendChild(ePanel);
      }
    }

    if (!renderedAny) {
      const note = document.createElement("div");
      note.className = "empty-notice";
      note.textContent =
        "No accessories are available for the selected base SKU(s). The base SKU is shippable on its own.";
      wrap.appendChild(note);
    }
  }

  // Pretty-print a category for the header
  function humanCat(cat: string): string {
    return cat
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/Wall Mount Accessories/, "Wall Mount Accessories")
      .replace(/\bAnd\b/g, "&");
  }

  // ── SKU generation + sidebar render ─────────────────────────────────
  function regenerate() {
    currentRows = generate(DATA, state);
    renderSkuList();
    updateButtons();
    pushHash();
    updateStepStates();
  }

  function renderSkuList() {
    const list = $(ids.skuList);
    const empty = $(ids.skuEmpty);
    const count = $(ids.skuCount);
    if (count) count.textContent = String(currentRows.length);
    if (!list) return;
    list.innerHTML = "";
    if (!currentRows.length) {
      if (empty) {
        empty.style.display = "";
        list.appendChild(empty);
      }
      return;
    }
    if (empty) empty.style.display = "none";
    const filter = ($<HTMLInputElement>(ids.searchInput || "")?.value || "")
      .trim()
      .toLowerCase();
    const sortMode = $<HTMLSelectElement>(ids.sortSelect || "")?.value || "default";
    let rows = currentRows.slice();
    if (filter) rows = rows.filter((r) => r.sku.toLowerCase().includes(filter));
    if (sortMode === "az") rows.sort((a, b) => a.sku.localeCompare(b.sku));
    else if (sortMode === "za") rows.sort((a, b) => b.sku.localeCompare(a.sku));
    else if (sortMode === "len")
      rows.sort((a, b) => a.sku.length - b.sku.length);
    rows.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "sku-row";
      const sku = filter
        ? r.sku.replace(
            new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"),
            (m) => `<mark>${m}</mark>`,
          )
        : r.sku;
      row.innerHTML = `<span class="sku-row-num">${i + 1}</span><span class="sku-row-val">${sku}</span><button class="sku-row-copy" type="button" title="Copy">⎘</button>`;
      const btn = row.querySelector("button");
      btn?.addEventListener("click", () => {
        navigator.clipboard.writeText(r.sku).catch(() => {});
        btn.textContent = "✓";
        btn.classList.add("ok");
        setTimeout(() => {
          btn.textContent = "⎘";
          btn.classList.remove("ok");
        }, 1200);
      });
      list.appendChild(row);
    });
  }

  function updateButtons() {
    const copyBtn = $<HTMLButtonElement>(ids.copyAllBtn);
    const expBtn = $<HTMLButtonElement>(ids.exportBtn);
    const shareBtn = ids.shareBtn ? $<HTMLButtonElement>(ids.shareBtn) : null;
    const hasRows = currentRows.length > 0;
    if (copyBtn) copyBtn.disabled = !hasRows;
    if (expBtn) expBtn.disabled = !hasRows;
    if (shareBtn) shareBtn.disabled = !state.parent;
  }

  // ── Step ribbon hooks (if present) ──────────────────────────────────
  function updateStepStates() {
    const path = $(ids.skuPath || "");
    if (path) {
      if (!state.parent) {
        path.innerHTML = "Awaiting selection.";
      } else {
        const fam = DATA.families[state.parent];
        const finishLabel = fam.brassOnly
          ? "brass (no suffix)"
          : state.finishes.length
            ? state.finishes.map((f) => f || "default").join(", ")
            : "default";
        path.innerHTML = `<code>${fam.label}</code> · base ${
          state.baseSkus.length || 0
        } · finish <code>${finishLabel}</code> · ${
          Object.values(state.accessories).flat().length
        } accessor${Object.values(state.accessories).flat().length === 1 ? "y" : "ies"}`;
      }
    }
  }

  // ── Reset / copy / export / share buttons ──────────────────────────
  function resetAll() {
    state = emptyState();
    if (parentSel) parentSel.value = "";
    onParentChange();
  }

  function copyAll() {
    if (!currentRows.length) return;
    const text = currentRows.map((r) => r.sku).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    showToast(`Copied ${currentRows.length} SKU${currentRows.length === 1 ? "" : "s"}`);
    const btn = $<HTMLButtonElement>(ids.copyAllBtn);
    if (btn) {
      btn.classList.add("ok");
      const prev = btn.innerHTML;
      btn.innerHTML = "✓ Copied!";
      setTimeout(() => {
        btn.classList.remove("ok");
        btn.innerHTML = prev;
      }, 1500);
    }
  }

  function exportCSV() {
    if (!currentRows.length) return;
    const catCols: string[] = [];
    for (const r of currentRows)
      for (const a of r.accessories)
        if (!catCols.includes(a.category)) catCols.push(a.category);
    const headers = ["SKU", "Parent SKU", "Base SKU", "Finish", ...catCols.map((c) => `${c} (code)`)];
    const csvRows = [headers];
    for (const r of currentRows) {
      const row = [
        r.sku,
        r.parent,
        r.baseSku,
        r.finishName + (r.finishCode ? ` (${r.finishCode})` : ""),
      ];
      for (const c of catCols) {
        const a = r.accessories.find((x) => x.category === c);
        row.push(a ? a.code : "");
      }
      csvRows.push(row);
    }
    const csv = csvRows
      .map((r) =>
        r
          .map((v) => {
            const s = String(v ?? "");
            return /[,\n"]/.test(s) ? `"${s.split('"').join('""')}"` : s;
          })
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `coppersmith_skus_${state.parent.replace(/[^a-z0-9]/gi, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function shareLink() {
    const url = window.location.origin + window.location.pathname + "#" + encodeState(state);
    navigator.clipboard.writeText(url).catch(() => {});
    showToast("Link copied to clipboard");
  }

  function showToast(msg: string) {
    if (!ids.toast) return;
    const t = $(ids.toast);
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1600);
  }

  // ── URL hash sync ──────────────────────────────────────────────────
  function pushHash() {
    if (suppressHash) return;
    const next = state.parent ? "#" + encodeState(state) : "";
    if (next === window.location.hash) return;
    history.replaceState(null, "", window.location.pathname + window.location.search + next);
  }

  function hydrateFromHash() {
    if (!window.location.hash) return;
    const restored = decodeState(window.location.hash);
    if (!restored.parent || !DATA.families[restored.parent]) return;
    suppressHash = true;
    if (parentSel) parentSel.value = restored.parent;
    onParentChange();
    state.baseSkus = restored.baseSkus.filter((sku) =>
      DATA.families[restored.parent].baseSkus.some((b) => b.sku === sku),
    );
    state.finishes = restored.finishes;
    state.accessories = restored.accessories;
    state.companions = restored.companions;
    // Reflect in DOM
    const grid = $(ids.baseGrid);
    grid?.querySelectorAll(`.${classes.baseTile}`).forEach((el) => {
      const v = (el as HTMLElement).dataset.value;
      if (v && state.baseSkus.includes(v)) el.classList.add(ON);
    });
    const finishGrid = $(ids.finishGrid);
    finishGrid?.querySelectorAll(`.${classes.finishTile}`).forEach((el) => {
      const v = (el as HTMLElement).dataset.code || "";
      if (state.finishes.includes(v)) el.classList.add(ON);
    });
    renderAccessories();
    regenerate();
    suppressHash = false;
  }

  // ── Wire up static buttons ─────────────────────────────────────────
  buildParentDropdown();
  buildFinishGrid();
  setStepEnabled(1, false);
  setStepEnabled(2, false);
  setStepEnabled(3, false);

  $(ids.resetBtn)?.addEventListener("click", resetAll);
  $(ids.copyAllBtn)?.addEventListener("click", copyAll);
  $(ids.exportBtn)?.addEventListener("click", exportCSV);
  if (ids.shareBtn) $(ids.shareBtn)?.addEventListener("click", shareLink);
  if (ids.searchInput)
    $(ids.searchInput)?.addEventListener("input", () => renderSkuList());
  if (ids.sortSelect)
    $(ids.sortSelect)?.addEventListener("change", () => renderSkuList());

  // Keyboard shortcuts: Cmd/Ctrl+C copies all when no text selection
  window.addEventListener("keydown", (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "c" &&
      !window.getSelection()?.toString()
    ) {
      const btn = $<HTMLButtonElement>(ids.copyAllBtn);
      if (btn && !btn.disabled) {
        e.preventDefault();
        copyAll();
      }
    }
    if (
      ids.searchInput &&
      e.key === "/" &&
      document.activeElement?.tagName !== "INPUT"
    ) {
      e.preventDefault();
      $<HTMLInputElement>(ids.searchInput)?.focus();
    }
  });

  // Hydrate from URL hash on load
  hydrateFromHash();
  // Initial render so the empty state shows
  regenerate();
}

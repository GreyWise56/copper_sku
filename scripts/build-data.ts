/**
 * TypeScript port of `extract_master_sheet.py` (v4).
 *
 * Reads `data/master_sheet.xlsx` (Master Sheet tab), classifies accessory
 * sides (top/bottom), wires companion rules, and writes
 *   src/data/families.json
 *   src/data/meta.json
 *
 * EE companion fix (spec §16b): companionOptions on Estate Extension is
 * the sentinel "*" — the engine interprets that as "show every CEILING
 * MOUNT option available for the selected base SKU(s)".
 */
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "data", "master_sheet.xlsx");
const OUT_FAMILIES = path.join(ROOT, "src", "data", "families.json");
const OUT_META = path.join(ROOT, "src", "data", "meta.json");

const ADDITIVE_CATEGORIES = new Set([
  "WALL MOUNT ACCESSORIES",
  "DECORATIVE OPTIONS",
]);

// EE companions: "*" = ALL CEILING MOUNT options compatible with the selected
// base SKU(s). The earlier v4 hard-coded list was too restrictive (spec §16b).
const GH_COMPANION_NAMES = ["Grand Post Fitter", "Post Fitter"];

type CompanionRule = {
  companionCategory: string;
  companionOptions: string[] | "*";
  panelTitle: string;
  panelNote: string;
};

const COMPANION_RULES: Record<string, CompanionRule> = {
  "Estate Extension": {
    companionCategory: "CEILING MOUNT",
    companionOptions: "*",
    panelTitle: "Estate Extension requires a ceiling & hanging companion",
    panelNote:
      "Each selected companion becomes a separate SKU variant. All CEILING MOUNT options compatible with the selected base SKU(s) are listed.",
  },
  'Grand Harbor 12"': {
    companionCategory: "POST & PIER MOUNT",
    companionOptions: GH_COMPANION_NAMES,
    panelTitle: 'Grand Harbor 12" requires PF or GPF',
    panelNote: "Each selected fitter becomes a separate SKU variant.",
  },
  'Grand Harbor 17"': {
    companionCategory: "POST & PIER MOUNT",
    companionOptions: GH_COMPANION_NAMES,
    panelTitle: 'Grand Harbor 17" requires PF or GPF',
    panelNote: "Each selected fitter becomes a separate SKU variant.",
  },
};

const EXCLUDED_BY_IGNITION: Record<string, string[]> = {
  "Chain Mount": ["Gas"],
  "Stem Mount": ["Gas"],
  "Quartet Chain Mount": ["Gas"],
  "Heavy Chain Mount": ["Gas"],
};

const EXCLUDES: Record<string, string[]> = {
  "Wind Guard (WGS or WGL)": ["Propane Tip", "e-lyte", "Auto Shutoff Valve"],
  "Propane Tip": ["Wind Guard (WGS or WGL)"],
  "e-lyte": ["Wind Guard (WGS or WGL)"],
  "Auto Shutoff Valve": ["Wind Guard (WGS or WGL)"],
};

const CAT_ORDER = [
  "WALL MOUNT",
  "WALL MOUNT ACCESSORIES",
  "CEILING MOUNT",
  "POST & PIER MOUNT",
  "DECORATIVE OPTIONS",
  "PARTS",
  "ELECTRIC",
  "GAS",
];
const MOUNT_MUTEX = [
  "WALL MOUNT",
  "WALL MOUNT ACCESSORIES",
  "CEILING MOUNT",
  "POST & PIER MOUNT",
];
const ACCESSORY_SECTIONS = new Set(CAT_ORDER);

function classifySide(name: string): "top" | "bottom" | null {
  const n = name.toLowerCase().trim();
  if (n.includes("bottom")) return "bottom";
  if (n.startsWith("reverse")) return "bottom";
  if (n.includes("top")) return "top";
  if (n.includes("farm house hook")) return "top";
  return null;
}

function formatParent(p: string): string {
  const m = /^([A-Z]+)([EG])$/.exec(p);
  return m ? `${m[1]}-${m[2]}` : p;
}

function extractSize(sku: string): string | null {
  let m = /^(\d+)[A-Z]+H?$/.exec(sku);
  if (m) return m[1];
  m = /^[A-Z]+(\d+)[EG]?$/.exec(sku);
  if (m) return m[1];
  return null;
}

type Cell = string | number | boolean | Date | null | undefined;
type Row = Cell[];

function cellStr(v: Cell): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

if (!fs.existsSync(SRC)) {
  console.error(`Master sheet not found at ${SRC}`);
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(SRC), { type: "buffer" });
const sheetName =
  wb.SheetNames.find((n) => n.toLowerCase().includes("master")) ??
  wb.SheetNames[0];
const ws = wb.Sheets[sheetName];

// Read entire sheet as array-of-arrays with raw values
const grid = XLSX.utils.sheet_to_json<Row>(ws, {
  header: 1,
  defval: null,
  raw: true,
  blankrows: true,
}) as Row[];

if (grid.length < 3) {
  console.error("Master sheet has fewer than 3 rows — nothing to extract.");
  process.exit(1);
}

const row1 = grid[0]; // section banners
const row2 = grid[1]; // sub-headers (accessory names)
const maxCols = Math.max(
  row1.length,
  row2.length,
  ...grid.map((r) => r.length),
);

// Determine section column ranges from row 1
const sectionStarts: number[] = [];
for (let c = 0; c < maxCols; c++) {
  const v = cellStr(row1[c]);
  if (v !== "") sectionStarts.push(c);
}
const sectionRanges: { start: number; end: number; name: string }[] = [];
for (let i = 0; i < sectionStarts.length; i++) {
  const s = sectionStarts[i];
  const end =
    i + 1 < sectionStarts.length ? sectionStarts[i + 1] - 1 : maxCols - 1;
  sectionRanges.push({ start: s, end, name: cellStr(row1[s]) });
}

// Map accessory columns → (category, accessory name)
const colToCategory = new Map<number, string>();
const colToAccName = new Map<number, string>();
for (const { start, end, name } of sectionRanges) {
  if (!ACCESSORY_SECTIONS.has(name)) continue;
  for (let c = start; c <= end; c++) {
    const accName = cellStr(row2[c]);
    if (accName !== "") {
      colToCategory.set(c, name);
      colToAccName.set(c, accName);
    }
  }
}

type Accessory = { code: string; name: string; category: string };
type Record_ = {
  sku: string;
  parent: string;
  collection: string;
  fixture: string;
  ignition: string;
  accessories: Accessory[];
};

// Column indexes (1-based in the original Python; here 0-based after subtracting 1)
const COL_SKU = 0;
const COL_PARENT = 1;
const COL_COLLECTION = 4;
const COL_FIXTURE = 6;
const COL_IGNITION = 8;

const records: Record_[] = [];
for (let r = 2; r < grid.length; r++) {
  const row = grid[r];
  const sku = cellStr(row[COL_SKU]);
  const parent = cellStr(row[COL_PARENT]);
  if (!sku || !parent) continue;
  const collection = cellStr(row[COL_COLLECTION]);
  if (!collection) continue;
  const fixture = cellStr(row[COL_FIXTURE]);
  const ignition = cellStr(row[COL_IGNITION]);

  const accessories: Accessory[] = [];
  for (const [c, cat] of colToCategory) {
    const v = cellStr(row[c]);
    if (v === "") continue;
    accessories.push({ code: v, name: colToAccName.get(c)!, category: cat });
  }

  records.push({ sku, parent, collection, fixture, ignition, accessories });
}

type AccessoryOption = {
  name: string;
  codes: Record<string, string>;
  side?: "top" | "bottom";
  triggersCompanion?: string;
  excludedByIgnition?: string[];
  excludes?: string[];
};

type Family = {
  label: string;
  ignition: string;
  fixture: string;
  isBiltmore: boolean;
  rawParent: string;
  brassOnly: boolean;
  baseSkus: { sku: string; size: string; sizeLabel: string }[];
  accessoryGrid: Record<string, AccessoryOption[]>;
};

// Build families
const families: Record<string, Family> = {};
type AccessoryGridBuild = Record<string, Record<string, Record<string, string>>>;
const buildGrid = new Map<string, AccessoryGridBuild>();

for (const rec of records) {
  const formatted = formatParent(rec.parent);
  const isBilt = rec.collection.includes("®");
  const collClean = rec.collection.replace(/®/g, "").trim();
  if (!families[formatted]) {
    families[formatted] = {
      label: collClean,
      ignition: rec.ignition,
      fixture: rec.fixture,
      isBiltmore: isBilt,
      rawParent: rec.parent,
      brassOnly: false,
      baseSkus: [],
      accessoryGrid: {},
    };
    buildGrid.set(formatted, {});
  }
  const fam = families[formatted];
  const size = extractSize(rec.sku);
  const sizeLabel = size
    ? `${collClean} ${size}"`
    : `${collClean} (${rec.sku})`;
  fam.baseSkus.push({ sku: rec.sku, size: size ?? rec.sku, sizeLabel });

  const grid = buildGrid.get(formatted)!;
  for (const acc of rec.accessories) {
    if (!grid[acc.category]) grid[acc.category] = {};
    if (!grid[acc.category][acc.name]) grid[acc.category][acc.name] = {};
    grid[acc.category][acc.name][rec.sku] = acc.code;
  }
}

// Brass-only / Copper label disambiguation
for (const fam of Object.values(families)) {
  const raw = fam.rawParent;
  if (raw.startsWith("AOB")) {
    if (!fam.label.includes("Brass")) fam.label += " Brass";
    fam.brassOnly = true;
  } else if (raw.startsWith("AO")) {
    if (!fam.label.includes("Copper")) fam.label += " Copper";
    fam.brassOnly = false;
  }
}

// Materialize accessory grid (ordered by CAT_ORDER, options sorted by name)
for (const [famKey, fam] of Object.entries(families)) {
  const built = buildGrid.get(famKey)!;
  const newGrid: Record<string, AccessoryOption[]> = {};
  for (const cat of CAT_ORDER) {
    const accs = built[cat];
    if (!accs) continue;
    const items: AccessoryOption[] = [];
    for (const [accName, codeMap] of Object.entries(accs)) {
      const item: AccessoryOption = { name: accName, codes: codeMap };
      if (ADDITIVE_CATEGORIES.has(cat)) {
        const side = classifySide(accName);
        if (side) item.side = side;
      }
      if (accName in COMPANION_RULES) item.triggersCompanion = accName;
      if (accName in EXCLUDED_BY_IGNITION)
        item.excludedByIgnition = EXCLUDED_BY_IGNITION[accName];
      if (accName in EXCLUDES) item.excludes = EXCLUDES[accName];
      items.push(item);
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    newGrid[cat] = items;
  }
  fam.accessoryGrid = newGrid;

  fam.baseSkus.sort((a, b) => {
    const ai = parseInt(a.size, 10);
    const bi = parseInt(b.size, 10);
    if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
    if (!isNaN(ai)) return -1;
    if (!isNaN(bi)) return 1;
    return a.size.localeCompare(b.size);
  });
}

const DATA = {
  finishes: [
    { code: "", name: "Antique Copper", color: "#c87941" },
    { code: "BLK", name: "Matte Black", color: "#2a2a2a" },
    { code: "GRAY", name: "Graphite Gray", color: "#6b7280" },
    { code: "BRZ", name: "Oil Rubbed Bronze", color: "#6b4226" },
    { code: "CLEAR", name: "Clear Coat", color: "#ffffff" },
  ],
  categoryOrder: CAT_ORDER,
  mountMutex: MOUNT_MUTEX,
  additiveCategories: Array.from(ADDITIVE_CATEGORIES).sort(),
  companionRules: COMPANION_RULES,
  families,
};

fs.mkdirSync(path.dirname(OUT_FAMILIES), { recursive: true });
fs.writeFileSync(OUT_FAMILIES, JSON.stringify(DATA));

const stat = fs.statSync(SRC);
const meta = {
  masterSheetName: path.basename(SRC),
  masterSheetMtime: stat.mtime.toISOString(),
  builtAt: new Date().toISOString(),
  familyCount: Object.keys(families).length,
};
fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

console.log(`Wrote ${OUT_FAMILIES} — ${meta.familyCount} families`);
console.log(`Wrote ${OUT_META}`);

// ───── Static API layer (spec §17.6) ───────────────────────────────────
// Pre-generated JSON files under public/api/v1/, served from Pages edge.
// Same in-memory structures power the UI (src/data/families.json) and the
// API mirror — one source of truth, no logic duplication.

const API_DIR = path.join(ROOT, "public", "api", "v1");
const API_FAMILIES_DIR = path.join(API_DIR, "families");
const API_BASESKUS_DIR = path.join(API_DIR, "base-skus");

fs.rmSync(API_DIR, { recursive: true, force: true });
fs.mkdirSync(API_FAMILIES_DIR, { recursive: true });
fs.mkdirSync(API_BASESKUS_DIR, { recursive: true });

const RULE_SET_VERSION = "v4";
const gitRev = (
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "dev"
).slice(0, 7);
const masterSheetDate = stat.mtime.toISOString().slice(0, 10);
const builtAt = meta.builtAt;

// Flatten every base SKU across families for the flat indexes
const allBaseSkus: Array<{
  sku: string;
  parent: string;
  family: string;
  size: string;
  sizeLabel: string;
  ignition: string;
  fixture: string;
}> = [];
for (const [famKey, fam] of Object.entries(families)) {
  for (const b of fam.baseSkus) {
    allBaseSkus.push({
      sku: b.sku,
      parent: famKey,
      family: fam.label,
      size: b.size,
      sizeLabel: b.sizeLabel,
      ignition: fam.ignition,
      fixture: fam.fixture,
    });
  }
}

// 1. version.json
const versionPayload = {
  masterSheetDate,
  builtAt,
  ruleSetVersion: RULE_SET_VERSION,
  families: Object.keys(families).length,
  baseSkus: allBaseSkus.length,
  gitRev,
};
fs.writeFileSync(
  path.join(API_DIR, "version.json"),
  JSON.stringify(versionPayload, null, 2),
);

// 2. index.json — API root document
const indexPayload = {
  name: "CopperSmith SKU API",
  version: "1.0.0",
  ruleSetVersion: RULE_SET_VERSION,
  masterSheetDate,
  builtAt,
  links: {
    self: "/api/v1/index.json",
    version: "/api/v1/version.json",
    families: "/api/v1/families.json",
    family: "/api/v1/families/{familyKey}.json",
    baseSkus: "/api/v1/base-skus.json",
    baseSku: "/api/v1/base-skus/{sku}.json",
    taxonomy: "/api/v1/taxonomy.json",
    finishes: "/api/v1/finishes.json",
    validate: "/api/v1/validate",
    resolve: "/api/v1/resolve",
    build: "/api/v1/build",
    search: "/api/v1/search",
    openapi: "/api/v1/openapi.json",
    docs: "/api/docs",
  },
  notes: {
    phase: "Phase 1 (static layer) — validate/resolve/build/search are listed for forward-compat and ship in Phase 2 as a Cloudflare Worker.",
    cache: "public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400",
    auth: "none — fully public read-only catalog data",
  },
};
fs.writeFileSync(
  path.join(API_DIR, "index.json"),
  JSON.stringify(indexPayload, null, 2),
);

// 3. finishes.json
const brassOnlyFamilies = Object.entries(families)
  .filter(([, f]) => f.brassOnly)
  .map(([k]) => k);
const finishesPayload = {
  finishes: DATA.finishes.map((f) => ({
    code: f.code,
    name: f.name,
    color: f.color,
    ...(f.code === "" ? { default: true } : {}),
  })),
  brassOnlyFamilies,
  notes: {
    antiqueCopper:
      "Empty-string finish code. No suffix appended to the SKU.",
    clearSwatch:
      "Swatch color renders as white (#ffffff) per Jordan's note, 2026-05-21.",
    brassOnly:
      "Listed families never receive a finish suffix. Output SKUs omit the finish segment entirely.",
  },
};
fs.writeFileSync(
  path.join(API_DIR, "finishes.json"),
  JSON.stringify(finishesPayload, null, 2),
);

// 4. taxonomy.json — rules + human-readable explanations
const taxonomyPayload = {
  ruleSetVersion: RULE_SET_VERSION,
  categoryOrder: CAT_ORDER,
  mountMutex: MOUNT_MUTEX,
  additiveCategories: Array.from(ADDITIVE_CATEGORIES).sort(),
  companionRules: COMPANION_RULES,
  ruleExplanations: {
    mountMutex:
      "WALL MOUNT, WALL MOUNT ACCESSORIES, CEILING MOUNT, and POST & PIER MOUNT are mutually exclusive at the category level. A single SKU contains options from at most one of these categories, with two companion exceptions (EE and GH).",
    additivePairs:
      "Within additiveCategories, accessories carry a side: 'top', 'bottom', or null (neutral). One top plus one bottom yields a single combined SKU. Multiple tops with no bottom yields one SKU per top. Neutrals tag along on every variant.",
    companionRules:
      "When an accessory listed in companionRules is selected, the target companionCategory panel is hidden and a dedicated companion sub-panel appears. One companion pick is required for a valid SKU. companionOptions value '*' means all options available in the target category for the selected base SKU.",
    ignitionExclusions:
      "Gas families do not surface the ELECTRIC category panel. Electric families do not surface the GAS category panel. The exclusion is at the category-render layer, not the data layer.",
    brassOnly:
      "Families with brassOnly: true (currently AOB-E and AOB-G) skip the finish suffix entirely. Output SKUs look like AOB28E with no finish code appended.",
    skuCodeOrder:
      "base + finish + mount + companion + decorative + electric + gas. Deterministic regardless of click order.",
  },
};
fs.writeFileSync(
  path.join(API_DIR, "taxonomy.json"),
  JSON.stringify(taxonomyPayload, null, 2),
);

// 5. families.json — slim index, no accessory grids
const familyKeysSorted = Object.keys(families).sort();
const familiesIndex = {
  count: familyKeysSorted.length,
  families: familyKeysSorted.map((key) => {
    const fam = families[key];
    return {
      key,
      label: fam.label,
      ignition: fam.ignition,
      fixture: fam.fixture,
      isBiltmore: fam.isBiltmore,
      brassOnly: fam.brassOnly,
      baseSkuCount: fam.baseSkus.length,
      links: {
        self: `/api/v1/families/${encodeURIComponent(key)}.json`,
        baseSkus: fam.baseSkus.map(
          (b) => `/api/v1/base-skus/${encodeURIComponent(b.sku)}.json`,
        ),
      },
    };
  }),
};
fs.writeFileSync(
  path.join(API_DIR, "families.json"),
  JSON.stringify(familiesIndex, null, 2),
);

// 6. families/{key}.json — full per-family payload
for (const key of familyKeysSorted) {
  const fam = families[key];
  // Augment accessoryGrid with explicit `multi` so consumers don't have to
  // re-derive it from additiveCategories + side classification.
  const grid: Record<string, unknown[]> = {};
  for (const [cat, opts] of Object.entries(fam.accessoryGrid)) {
    grid[cat] = opts.map((o) => ({
      name: o.name,
      ...(o.side ? { side: o.side } : {}),
      multi:
        Array.from(ADDITIVE_CATEGORIES).includes(cat) && !!o.side,
      ...(o.triggersCompanion
        ? { triggersCompanion: o.triggersCompanion }
        : {}),
      ...(o.excludedByIgnition
        ? { excludedByIgnition: o.excludedByIgnition }
        : {}),
      ...(o.excludes ? { excludes: o.excludes } : {}),
      codes: o.codes,
    }));
  }
  const famPayload = {
    key,
    label: fam.label,
    ignition: fam.ignition,
    fixture: fam.fixture,
    isBiltmore: fam.isBiltmore,
    brassOnly: fam.brassOnly,
    baseSkus: fam.baseSkus,
    accessoryGrid: grid,
    links: {
      self: `/api/v1/families/${encodeURIComponent(key)}.json`,
      index: "/api/v1/families.json",
      taxonomy: "/api/v1/taxonomy.json",
    },
  };
  // Encode the family key in the filename — most keys are already URL-safe
  // (e.g. "AS-E") but a few contain reserved chars. Pages serves on the
  // literal file path; we keep filenames URL-safe by leaving the dash alone.
  fs.writeFileSync(
    path.join(API_FAMILIES_DIR, `${key}.json`),
    JSON.stringify(famPayload, null, 2),
  );
}

// 7. base-skus.json — flat index of every base SKU
allBaseSkus.sort((a, b) => a.sku.localeCompare(b.sku));
const baseSkusIndex = {
  count: allBaseSkus.length,
  baseSkus: allBaseSkus.map((b) => ({
    ...b,
    links: { self: `/api/v1/base-skus/${encodeURIComponent(b.sku)}.json` },
  })),
};
fs.writeFileSync(
  path.join(API_DIR, "base-skus.json"),
  JSON.stringify(baseSkusIndex, null, 2),
);

// 8. base-skus/{sku}.json — per-SKU detail with resolved accessory list
for (const b of allBaseSkus) {
  const fam = families[b.parent];
  const resolved: Array<{
    category: string;
    name: string;
    code: string;
    side?: "top" | "bottom";
    multi: boolean;
    triggersCompanion?: string;
  }> = [];
  for (const cat of CAT_ORDER) {
    const opts = fam.accessoryGrid[cat];
    if (!opts) continue;
    for (const o of opts) {
      const code = o.codes[b.sku];
      if (!code) continue;
      resolved.push({
        category: cat,
        name: o.name,
        code,
        ...(o.side ? { side: o.side } : {}),
        multi: Array.from(ADDITIVE_CATEGORIES).includes(cat) && !!o.side,
        ...(o.triggersCompanion
          ? { triggersCompanion: o.triggersCompanion }
          : {}),
      });
    }
  }
  const finishesAvailable = fam.brassOnly
    ? []
    : DATA.finishes.map((f) => f.code);
  const payload = {
    sku: b.sku,
    parent: b.parent,
    family: b.family,
    size: b.size,
    sizeLabel: b.sizeLabel,
    ignition: b.ignition,
    fixture: b.fixture,
    brassOnly: fam.brassOnly,
    finishesAvailable,
    accessories: resolved,
    links: {
      self: `/api/v1/base-skus/${encodeURIComponent(b.sku)}.json`,
      family: `/api/v1/families/${encodeURIComponent(b.parent)}.json`,
      taxonomy: "/api/v1/taxonomy.json",
    },
  };
  fs.writeFileSync(
    path.join(API_BASESKUS_DIR, `${b.sku}.json`),
    JSON.stringify(payload, null, 2),
  );
}

// 9. openapi.json — hand-rolled Phase 1, covers only the static endpoints.
//    Phase 2 will regenerate this from Zod schemas once the Worker ships
//    (spec §17.5).
const openapi = {
  openapi: "3.1.0",
  info: {
    title: "CopperSmith SKU API",
    version: "1.0.0",
    description:
      "Read-only public API for CopperSmith lantern SKU resolution. Phase 1 (current): static catalog endpoints (the JSON files served from Cloudflare Pages edge). Phase 2: dynamic endpoints (validate, resolve, build, search) shipped as a Cloudflare Worker. See /api/docs for the interactive docs and /llms.txt for the rules reference.",
    contact: {
      name: "JAM Group Studio",
      email: "tech@thecoppersmith.net",
    },
    license: {
      name: "Public read-only",
      identifier: "CC-BY-4.0",
    },
  },
  servers: [
    {
      url: "https://sku.thecoppersmith.net/api/v1",
      description: "Production (custom domain — DNS pending Tuesday)",
    },
    {
      url: "https://copper-sku.pages.dev/api/v1",
      description: "Cloudflare Pages preview",
    },
  ],
  tags: [
    {
      name: "Catalog (static)",
      description:
        "Pre-generated JSON files served from the edge cache. Cache-Control: public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400.",
    },
    {
      name: "SKU resolution (dynamic)",
      description:
        "Phase 2 endpoints — shipped as a Cloudflare Worker that imports the same TypeScript engine the UI uses. Not yet live.",
    },
    {
      name: "Search",
      description: "Fuzzy search over families, base SKUs, accessories. Phase 2.",
    },
  ],
  paths: {
    "/index.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "API root document",
        description:
          "Lists every endpoint with a short label. The entry point for AI agents discovering the API.",
        responses: {
          "200": {
            description: "API root",
            content: {
              "application/json": {
                example: indexPayload,
              },
            },
          },
        },
      },
    },
    "/version.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Build provenance",
        description:
          "Master sheet date, build timestamp, rule set version, counts, git rev. PIM sync jobs hit this first to decide whether to re-pull.",
        responses: {
          "200": {
            description: "Version block",
            content: {
              "application/json": {
                example: versionPayload,
              },
            },
          },
        },
      },
    },
    "/families.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Family index (slim)",
        description:
          "Every family with its label, ignition, fixture, base SKU count, and per-family + base-SKU links. No accessory grid — fetch /families/{key}.json for that.",
        responses: {
          "200": {
            description: "Family index",
            content: { "application/json": {} },
          },
        },
      },
    },
    "/families/{familyKey}.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Full family payload",
        description:
          "One family with its full accessory grid and base SKU list. familyKey looks like 'AS-E' or 'AOB-G'.",
        parameters: [
          {
            name: "familyKey",
            in: "path",
            required: true,
            schema: { type: "string", example: "AS-E" },
            description: "Family key (e.g. AS-E, AOB-G)",
          },
        ],
        responses: {
          "200": {
            description: "Family payload",
            content: { "application/json": {} },
          },
          "404": { description: "Unknown family key" },
        },
      },
    },
    "/base-skus.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Base SKU index (flat)",
        description:
          "Every base SKU across every family. Marketplace feed generation and warehouse seed scripts use this.",
        responses: {
          "200": {
            description: "Base SKU index",
            content: { "application/json": {} },
          },
        },
      },
    },
    "/base-skus/{sku}.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Per-base-SKU detail",
        description:
          "Base SKU detail with the accessory list already resolved for that SKU. Used by Shopify/WooCommerce/BigCommerce product detail pages.",
        parameters: [
          {
            name: "sku",
            in: "path",
            required: true,
            schema: { type: "string", example: "AS41E" },
            description: "Base SKU (e.g. AS41E, AOB28E)",
          },
        ],
        responses: {
          "200": {
            description: "Base SKU payload",
            content: { "application/json": {} },
          },
          "404": { description: "Unknown base SKU" },
        },
      },
    },
    "/taxonomy.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Rule set + human-readable explanations",
        description:
          "Category order, mount mutex, additive categories, companion rules, plus human-readable ruleExplanations. The rules of the game.",
        responses: {
          "200": {
            description: "Taxonomy payload",
            content: { "application/json": {} },
          },
        },
      },
    },
    "/finishes.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "Finish definitions",
        description:
          "The five finishes plus the brassOnlyFamilies exclusion list and human-readable notes.",
        responses: {
          "200": {
            description: "Finish payload",
            content: { "application/json": {} },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Catalog (static)"],
        summary: "This document",
        description: "OpenAPI 3.1 spec for the SKU API.",
        responses: {
          "200": {
            description: "OpenAPI document",
            content: { "application/json": {} },
          },
        },
      },
    },
    "/validate": {
      post: {
        tags: ["SKU resolution (dynamic)"],
        summary: "Validate a SKU string (Phase 2)",
        description:
          "Parse a SKU like 'AS41E-BLK-TS3-LTS' and check it against the rules. Not yet live — ships in Phase 2 as a Cloudflare Worker.",
        deprecated: false,
        responses: {
          "503": {
            description:
              "Phase 2 endpoint — not yet implemented. See /api/docs for status.",
          },
        },
      },
    },
    "/resolve": {
      post: {
        tags: ["SKU resolution (dynamic)"],
        summary: "Resolve selections to a canonical SKU (Phase 2)",
        description:
          "Submit a configurator selection and get back the SKU string. Not yet live — ships in Phase 2.",
        responses: {
          "503": { description: "Phase 2 endpoint — not yet implemented." },
        },
      },
    },
    "/build": {
      post: {
        tags: ["SKU resolution (dynamic)"],
        summary: "Bulk SKU enumeration (Phase 2)",
        description:
          "Cartesian product across base SKUs, finishes, and accessory picks. Not yet live — ships in Phase 2.",
        responses: {
          "503": { description: "Phase 2 endpoint — not yet implemented." },
        },
      },
    },
    "/search": {
      get: {
        tags: ["Search"],
        summary: "Fuzzy search (Phase 2)",
        description:
          "Search families, base SKUs, accessory names. Not yet live — ships in Phase 2.",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", default: 10, maximum: 50 },
          },
        ],
        responses: {
          "503": { description: "Phase 2 endpoint — not yet implemented." },
        },
      },
    },
  },
};
fs.writeFileSync(
  path.join(API_DIR, "openapi.json"),
  JSON.stringify(openapi, null, 2),
);

console.log(
  `Wrote API mirror under ${API_DIR} — ` +
    `${familyKeysSorted.length} families, ${allBaseSkus.length} base SKUs`,
);

// ───── --verify ────────────────────────────────────────────────────────
// CI / local check that every expected file landed on disk.
if (process.argv.includes("--verify")) {
  const missing: string[] = [];
  const expected: string[] = [
    "index.json",
    "version.json",
    "families.json",
    "base-skus.json",
    "taxonomy.json",
    "finishes.json",
    "openapi.json",
  ];
  for (const f of expected) {
    if (!fs.existsSync(path.join(API_DIR, f))) missing.push(f);
  }
  for (const key of familyKeysSorted) {
    const p = path.join(API_FAMILIES_DIR, `${key}.json`);
    if (!fs.existsSync(p)) missing.push(`families/${key}.json`);
  }
  for (const b of allBaseSkus) {
    const p = path.join(API_BASESKUS_DIR, `${b.sku}.json`);
    if (!fs.existsSync(p)) missing.push(`base-skus/${b.sku}.json`);
  }
  if (missing.length) {
    console.error(
      `--verify FAILED: ${missing.length} expected file(s) missing:`,
    );
    for (const m of missing.slice(0, 20)) console.error(`  - ${m}`);
    if (missing.length > 20)
      console.error(`  … and ${missing.length - 20} more`);
    process.exit(1);
  }
  console.log(
    `--verify OK: ${expected.length + familyKeysSorted.length + allBaseSkus.length} files present`,
  );
}

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

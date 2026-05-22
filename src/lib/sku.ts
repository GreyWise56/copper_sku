/**
 * SKU generation — port of v4 HTML's combinationsForCategory + buildOneSku +
 * cartesian + generate. No DOM, no React; just data in → SKU rows out.
 */
import type { AccessoryOption, DataBlob, Family, GeneratedSku, State } from "./types";
import { activeTriggers } from "./constraints";

function cartesian<T>(...arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((a) => arr.map((b) => a.concat([b]))),
    [[]],
  );
}

type Selection = { category: string; name: string };

/**
 * Decide variant combinations within a category.
 *   - Additive categories (Wall Mount Accessories, Decorative Options):
 *       tops × bottoms cross-product, neutrals tag along on each variant.
 *       Two tops (or two bottoms) → separate variants.
 *   - Non-additive: every pick is its own variant.
 */
export function combinationsForCategory(
  data: DataBlob,
  fam: Family,
  cat: string,
  picks: string[],
): Selection[][] {
  const opts = fam.accessoryGrid[cat] || [];
  const additive = data.additiveCategories.includes(cat);
  if (!additive) return picks.map((name) => [{ category: cat, name }]);

  const tops: string[] = [];
  const bottoms: string[] = [];
  const neutrals: string[] = [];
  for (const p of picks) {
    const opt = opts.find((o) => o.name === p);
    const side = opt?.side;
    if (side === "top") tops.push(p);
    else if (side === "bottom") bottoms.push(p);
    else neutrals.push(p);
  }

  const topAxis: (string | null)[] = tops.length ? tops : [null];
  const botAxis: (string | null)[] = bottoms.length ? bottoms : [null];

  const variants: Selection[][] = [];
  for (const t of topAxis) {
    for (const b of botAxis) {
      const v: Selection[] = [];
      if (t) v.push({ category: cat, name: t });
      if (b) v.push({ category: cat, name: b });
      for (const n of neutrals) v.push({ category: cat, name: n });
      if (v.length) variants.push(v);
    }
  }
  return variants.length ? variants : [[]];
}

function resolveCode(
  fam: Family,
  category: string,
  accName: string,
  baseSku: string,
): string | null {
  const opt = (fam.accessoryGrid[category] || []).find((o) => o.name === accName);
  return opt ? opt.codes[baseSku] ?? null : null;
}

export function buildOneSku(
  data: DataBlob,
  fam: Family,
  parentKey: string,
  baseSku: string,
  finishCode: string,
  accessorySelections: Selection[],
  companionPicks: Record<string, string>,
): GeneratedSku | null {
  const parts = [baseSku];
  const finishDef = data.finishes.find((f) => f.code === finishCode);
  if (finishCode) parts.push(finishCode);

  const trail: GeneratedSku["accessories"] = [];
  for (const sel of accessorySelections) {
    const code = resolveCode(fam, sel.category, sel.name, baseSku);
    if (!code) return null;
    trail.push({ category: sel.category, name: sel.name, code });
    parts.push(code);

    // Inject companion immediately after a trigger
    const cmpName = companionPicks[sel.name];
    if (cmpName) {
      const rule = data.companionRules[sel.name];
      const cmpCode = resolveCode(fam, rule.companionCategory, cmpName, baseSku);
      if (!cmpCode) return null;
      trail.push({ category: rule.companionCategory, name: cmpName, code: cmpCode });
      parts.push(cmpCode);
    }
  }

  return {
    sku: parts.join("-"),
    parent: parentKey,
    baseSku,
    finishCode: finishCode || "",
    finishName: finishDef ? finishDef.name : "Antique Copper",
    accessories: trail,
  };
}

export function generate(data: DataBlob, state: State): GeneratedSku[] {
  if (!state.parent || !state.baseSkus.length) return [];
  const fam = data.families[state.parent];
  if (!fam) return [];

  const fins = state.finishes.length ? state.finishes : [""];

  const catVariantLists: Selection[][][] = [];
  for (const cat of data.categoryOrder) {
    const picks = state.accessories[cat] || [];
    if (!picks.length) continue;
    catVariantLists.push(combinationsForCategory(data, fam, cat, picks));
  }
  if (!catVariantLists.length) catVariantLists.push([[]]);

  // Companion axes
  const triggers = activeTriggers(data, state);
  type CompanionAxisItem = [string, string | null];
  const companionAxes: CompanionAxisItem[][] = [];
  for (const t of triggers) {
    const picks = state.companions[t] || [];
    const axis: CompanionAxisItem[] = picks.length
      ? picks.map((p) => [t, p] as CompanionAxisItem)
      : [[t, null] as CompanionAxisItem];
    companionAxes.push(axis);
  }
  if (!companionAxes.length) companionAxes.push([["__none__", null]]);

  const accChains = cartesian(...catVariantLists).map((chain) =>
    chain.reduce<Selection[]>((acc, x) => acc.concat(x), []),
  );

  const rows: GeneratedSku[] = [];
  for (const bsk of state.baseSkus) {
    for (const fin of fins) {
      for (const companionCombo of cartesian(...companionAxes)) {
        const companionMap: Record<string, string> = {};
        for (const pair of companionCombo) {
          if (pair[1]) companionMap[pair[0]] = pair[1];
        }
        for (const chain of accChains) {
          const sku = buildOneSku(
            data,
            fam,
            state.parent,
            bsk,
            fin,
            chain,
            companionMap,
          );
          if (sku) rows.push(sku);
        }
      }
    }
  }
  return rows;
}

/**
 * Look up the original cell code for an accessory option/base SKU.
 * Returns null if the option does not exist for that base SKU.
 */
export function codeFor(
  fam: Family,
  category: string,
  accName: string,
  baseSku: string,
): string | null {
  return resolveCode(fam, category, accName, baseSku);
}

/**
 * Best-effort "display code" for an accessory option (used in chip rendering
 * before SKUs are generated). Returns the code for the first selected base
 * SKU if present, otherwise the first available code in the option's map.
 */
export function displayCode(
  opt: AccessoryOption,
  baseSkus: string[],
): string {
  for (const sku of baseSkus) {
    const c = opt.codes[sku];
    if (c) return c;
  }
  const vals = Object.values(opt.codes);
  return vals[0] ?? "";
}

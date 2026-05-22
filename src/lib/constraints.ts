/**
 * Constraint helpers — port of v4 HTML's constraint section.
 *
 * Encodes:
 *   - Mount-category mutual exclusion (WALL MOUNT, WMA, CEILING, POST/PIER).
 *   - Companion-trigger handling: when EE or GH is picked, the regular target
 *     panel is hidden and a companion sub-panel is shown instead.
 *   - EE companion: ALL CEILING MOUNT options for the selected base SKU(s)
 *     (spec §16b). GH stays filtered to PF/GPF.
 *   - Per-accessory mutual-exclusion (Wind Guard vs PT/ELI/ASV, etc.).
 *   - Ignition-based filtering (CHM/SM/QCM/HCHM hidden for Gas).
 */
import type {
  AccessoryOption,
  CompanionRule,
  DataBlob,
  Family,
  State,
} from "./types";

export function pickedInCategory(state: State, cat: string): string[] {
  return (state.accessories[cat] || []).slice();
}

export function activeTriggers(data: DataBlob, state: State): string[] {
  const out: string[] = [];
  for (const trigger of Object.keys(data.companionRules)) {
    for (const cat of data.categoryOrder) {
      if ((state.accessories[cat] || []).includes(trigger)) {
        out.push(trigger);
        break;
      }
    }
  }
  return out;
}

export function getActiveMountCategory(
  data: DataBlob,
  state: State,
): string | null {
  for (const cat of data.mountMutex) {
    if (pickedInCategory(state, cat).length > 0) return cat;
  }
  return null;
}

export function isMountCategoryDisabled(
  data: DataBlob,
  state: State,
  cat: string,
): boolean {
  const active = getActiveMountCategory(data, state);
  if (!active || active === cat) return false;
  return data.mountMutex.includes(cat);
}

export function isCategoryHiddenByCompanion(
  data: DataBlob,
  state: State,
  cat: string,
): boolean {
  for (const trigger of activeTriggers(data, state)) {
    const rule = data.companionRules[trigger];
    if (rule && rule.companionCategory === cat) return true;
  }
  return false;
}

export function isAccessoryExcluded(
  data: DataBlob,
  state: State,
  fam: Family,
  accObj: AccessoryOption,
): boolean {
  if (
    accObj.excludedByIgnition &&
    accObj.excludedByIgnition.includes(fam.ignition)
  )
    return true;
  for (const otherCat of Object.keys(state.accessories)) {
    const picks = state.accessories[otherCat];
    if (!picks || !picks.length) continue;
    for (const pickName of picks) {
      const opts = fam.accessoryGrid[otherCat] || [];
      const opt = opts.find((o) => o.name === pickName);
      if (opt && opt.excludes && opt.excludes.includes(accObj.name))
        return true;
    }
  }
  return false;
}

/**
 * Resolve a companion-rule's option list against the family's actual
 * accessoryGrid. "*" sentinel ⇒ every option in the target category that's
 * available for every selected base SKU. Otherwise the explicit list, filtered
 * the same way.
 */
export function resolveCompanionOptions(
  rule: CompanionRule,
  fam: Family,
  selectedBaseSkus: string[],
): AccessoryOption[] {
  const all = fam.accessoryGrid[rule.companionCategory] || [];
  const baseFilter = (o: AccessoryOption) =>
    selectedBaseSkus.every((sku) => o.codes[sku] !== undefined);
  if (rule.companionOptions === "*") return all.filter(baseFilter);
  const wanted = new Set(rule.companionOptions);
  return all.filter((o) => wanted.has(o.name) && baseFilter(o));
}

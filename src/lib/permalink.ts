/**
 * Permalink encoder/decoder for SKU builder state.
 *
 * Format (URL hash, colon-separated):
 *   #parent:baseSkuA,baseSkuB:fin1,fin2:CATEGORY=Name,Name|CATEGORY2=Name|COMPANION:Trigger=Companion
 *
 * Backwards-compatible permissive decode — unknown segments are ignored.
 */
import type { State } from "./types";
import { emptyState } from "./types";

const ENC = (s: string) => encodeURIComponent(s);
const DEC = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function encodeState(state: State): string {
  const parts: string[] = [];
  parts.push(ENC(state.parent));
  parts.push(state.baseSkus.map(ENC).join(","));
  parts.push(state.finishes.map(ENC).join(","));

  const accPairs: string[] = [];
  for (const [cat, names] of Object.entries(state.accessories)) {
    if (!names.length) continue;
    accPairs.push(`${ENC(cat)}=${names.map(ENC).join(",")}`);
  }
  parts.push(accPairs.join("|"));

  const cmpPairs: string[] = [];
  for (const [trigger, names] of Object.entries(state.companions)) {
    if (!names.length) continue;
    cmpPairs.push(`${ENC(trigger)}=${names.map(ENC).join(",")}`);
  }
  parts.push(cmpPairs.join("|"));

  return parts.join(":");
}

export function decodeState(hash: string): State {
  const state = emptyState();
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return state;
  const parts = raw.split(":");
  state.parent = DEC(parts[0] || "");
  state.baseSkus = (parts[1] || "")
    .split(",")
    .filter(Boolean)
    .map(DEC);
  state.finishes = (parts[2] || "")
    .split(",")
    .filter(Boolean)
    .map(DEC);

  for (const chunk of (parts[3] || "").split("|").filter(Boolean)) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const cat = DEC(chunk.slice(0, eq));
    const names = chunk
      .slice(eq + 1)
      .split(",")
      .filter(Boolean)
      .map(DEC);
    if (cat && names.length) state.accessories[cat] = names;
  }

  for (const chunk of (parts[4] || "").split("|").filter(Boolean)) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const trigger = DEC(chunk.slice(0, eq));
    const names = chunk
      .slice(eq + 1)
      .split(",")
      .filter(Boolean)
      .map(DEC);
    if (trigger && names.length) state.companions[trigger] = names;
  }

  return state;
}

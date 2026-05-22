export type FinishDef = { code: string; name: string; color: string };

export type AccessoryOption = {
  name: string;
  codes: Record<string, string>;
  side?: "top" | "bottom";
  triggersCompanion?: string;
  excludedByIgnition?: string[];
  excludes?: string[];
};

export type Family = {
  label: string;
  ignition: string;
  fixture: string;
  isBiltmore: boolean;
  brassOnly: boolean;
  rawParent: string;
  baseSkus: { sku: string; size: string; sizeLabel: string }[];
  accessoryGrid: Record<string, AccessoryOption[]>;
};

export type CompanionRule = {
  companionCategory: string;
  companionOptions: string[] | "*";
  panelTitle: string;
  panelNote: string;
};

export type DataBlob = {
  finishes: FinishDef[];
  categoryOrder: string[];
  mountMutex: string[];
  additiveCategories: string[];
  companionRules: Record<string, CompanionRule>;
  families: Record<string, Family>;
};

export type State = {
  parent: string;
  baseSkus: string[];
  finishes: string[];
  accessories: Record<string, string[]>;
  companions: Record<string, string[]>;
};

export type GeneratedSku = {
  sku: string;
  parent: string;
  baseSku: string;
  finishCode: string;
  finishName: string;
  accessories: { category: string; name: string; code: string }[];
};

export const emptyState = (): State => ({
  parent: "",
  baseSkus: [],
  finishes: [],
  accessories: {},
  companions: {},
});

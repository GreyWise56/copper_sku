import data from "../data/families.json";
import meta from "../data/meta.json";
import type { DataBlob } from "./types";

export const DATA = data as unknown as DataBlob;
export const META = meta as {
  masterSheetName: string;
  masterSheetMtime: string;
  builtAt: string;
  familyCount: number;
};

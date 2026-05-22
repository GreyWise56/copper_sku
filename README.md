# CopperSmith SKU Builder

Live tool for assembling buildable CopperSmith lantern SKUs. Two visual
treatments (Showroom, Workbench) sharing one engine and one data source.

- **Live URL** (custom): `sku.thecoppersmith.net` (DNS pending — Tuesday)
- **Preview URL**: `https://copper-sku.pages.dev`
- **Source of truth**: `data/master_sheet.xlsx` (mirror of the Master Sheet
  tab from `CS_Master_Product_List_May_2026.xlsx`)
- **Operator**: Eric (GreyWise / JAM Group Studio), eric@jamgroupstudio.com
- **Hosting**: Cloudflare Pages, account `58b5853e7b009c8c4ac797b112e73ca6`
- **Repo**: `github.com/GreyWise56/copper_sku`

## Architecture

```
data/master_sheet.xlsx
        │
        ▼ scripts/build-data.ts  (runs as prebuild)
        │
src/data/families.json + meta.json
        │
        ▼ src/lib/{data,constraints,sku,permalink,controller}.ts
        │
        ▼ src/pages/{index,workbench,showroom}.astro + print/index.astro
        │
        ▼ npm run build
        │
        ▼ dist/  (deployed to Cloudflare Pages)
```

## Updating the master sheet

1. Replace `data/master_sheet.xlsx` with the new file (keep the filename).
2. `npm run build` locally to verify nothing breaks.
3. `git commit -am "data: master sheet YYYY-MM-DD"` and push.
4. Cloudflare Pages auto-rebuilds.

The build script reads row 1 (section banners) and row 2 (accessory names)
to identify accessory columns. As long as those rows stay consistent, new
rows / new accessory columns flow through without code changes.

## Constraint rules

Encoded in `src/lib/constraints.ts`. Top-level summary:

- **Parent SKU is organizational** — never appears in the buildable string.
- **Per-base-SKU code resolution** — every accessory code is looked up per
  base SKU (e.g. AS41G + Top Scroll → TS3, AS43G + Top Scroll → TS11).
- **Mount mutex** — WALL MOUNT / WALL MOUNT ACCESSORIES / CEILING MOUNT /
  POST & PIER MOUNT are mutually exclusive on a single output SKU.
- **EE companion** — Estate Extension hides the regular CEILING MOUNT panel
  and shows a companion sub-panel listing **all** CEILING MOUNT options
  compatible with the selected base SKU(s) (spec §16b — was previously a
  hardcoded subset).
- **GH companion** — Grand Harbor 12"/17" still filters to PF / GPF only.
- **Top/Bottom additive logic** — in WALL MOUNT ACCESSORIES and DECORATIVE
  OPTIONS, one top + one bottom combine on a single SKU; two tops or two
  bottoms fork into separate variants. Neutrals tag along.
- **Ignition filters** — Gas hides CHM / SM / QCM / HCHM from CEILING MOUNT.
- **WG vs PT/ELI/ASV** — picking one greys out the other inside GAS.
- **AOB brass-only** — finish picker hidden; no finish suffix on the SKU.

If a rule changes:

1. Edit `scripts/build-data.ts` (companion rules, exclusions) or
   `src/lib/constraints.ts` (UI behavior).
2. Update `public/llm.txt` and `public/human.txt` to match.
3. Rebuild + commit.

## Commands

| Command              | Action                                          |
| -------------------- | ----------------------------------------------- |
| `npm install`        | Install dependencies                            |
| `npm run dev`        | Local dev server at `localhost:4321`            |
| `npm run build`      | Build production output to `dist/`              |
| `npm run preview`    | Preview the production build locally            |
| `npm run deploy`     | Deploy `dist/` to Cloudflare Pages via Wrangler |

## Routes

| Path                    | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `/`                     | Directions — pick Showroom or Workbench            |
| `/workbench`            | Dense, monospace, PIM-ready builder                |
| `/showroom`             | Heritage, branded, retailer-facing builder         |
| `/print/?sku=…` or `/print/#…` | Tear-sheet for a single SKU              |
| `/llm.txt`              | AI assistant reference                             |
| `/human.txt`            | Human-readable SKU formula                         |

## Permalinks

Selection state lives in the URL hash. Format:

```
/workbench#parent:bases:finishes:CATEGORY=AccessoryName,Name|CAT2=…:Trigger=Companion
```

`src/lib/permalink.ts` encodes/decodes. The "Share link" button copies
`window.location.href` to clipboard.

## Contact

- Eric, eric@jamgroupstudio.com — operator
- Jordan — data + rule clarifications, master sheet ownership

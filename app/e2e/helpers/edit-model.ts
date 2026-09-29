/**
 * A real Calcula model for the "edit" area's journey: the sales-star fixture as
 * CSV files bound by a `csv` source -- the recipe of journeys/canvas.spec.ts #11
 * (and insight-overlays-pivot.spec.ts). Used by the W15 check, which needs a
 * MODEL slicer: its click awaits a model re-query inside the backend command,
 * which is the window an Undo must be refused in.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { invoke } from "./edit-harness";

const MODEL_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/model");
const MODEL_SOURCE_ID = "star_csv";

interface StarBundle {
  model: {
    tables: Array<{ name: string; columns: Array<{ name: string; data_type: unknown }>; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  data: Record<string, { columns: string[]; rows: unknown[][] }>;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeStarAsCsv(dir: string, factMultiplier: number): Record<string, unknown> {
  const bundle = JSON.parse(fs.readFileSync(path.join(MODEL_FIXTURE_DIR, "sales_star.json"), "utf8")) as StarBundle;
  for (const [table, { columns, rows }] of Object.entries(bundle.data)) {
    const file = path.join(dir, `${table}.csv`);
    const body = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
    fs.writeFileSync(file, columns.join(",") + "\n" + body, "utf8");
    // The FACT table repeated: a bigger model makes every re-query slower,
    // which widens the window a slicer click spends landing.
    if (table === "Sales") for (let i = 1; i < factMultiplier; i++) fs.appendFileSync(file, body, "utf8");
  }
  const model: Record<string, unknown> = { ...bundle.model };
  model.tables = bundle.model.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => (c.data_type === "Int32" ? { ...c, data_type: "Int64" } : c)),
    source_binding: { source_id: MODEL_SOURCE_ID, schema: "csv", table: t.name },
  }));
  model.sources = [
    {
      id: MODEL_SOURCE_ID,
      kind: "csv",
      connection: { database: dir, default_schema: "csv" },
      preferred_auth: "integrated",
      display_name: "Sales star (CSV)",
    },
  ];
  return model;
}

/** Create a live BI connection over the fixture; returns its id and the CSV dir to delete afterwards. */
export async function createStarConnection(page: Page, name: string, factMultiplier = 1): Promise<{ connectionId: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-edit-model-"));
  const model = writeStarAsCsv(dir, factMultiplier);
  const info = await invoke<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
  }, 180_000);
  await invoke(page, "bi_model_connect_source", { connectionId: info.id, sourceId: MODEL_SOURCE_ID, connectionString: "", remember: false }, 180_000);
  return { connectionId: info.id, dir };
}

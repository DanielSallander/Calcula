// FILENAME: tests/fixtures/model/gen-renamed-star.mjs
// PURPOSE: A SECOND schema for the design-query corpus — the same star, the same
//          rows, the same questions, under a different vocabulary.
// CONTEXT: Every design-query number this project has ever recorded was measured
//          against ONE fixture (`sales_star.json`, hardcoded in the runner). So
//          17/40 might be a fact about the model's grasp of the DSL, or a fact
//          about `sales_star` — and nothing distinguishes those two readings.
//
//          WHY A RENAME AND NOT A NEW DOMAIN. A second hand-written schema
//          changes the vocabulary AND the shape AND the questions at once, so a
//          score drop has three explanations and settles nothing. This one
//          changes exactly one variable: the structure, the row values, the
//          measure definitions and the semantics of all 40 tasks are IDENTICAL,
//          and only the names differ. A drop is then attributable — the model
//          was leaning on the words.
//
//          WHAT IS DELIBERATELY NOT RENAMED: the calendar columns (Date, Year,
//          Month, MonthName, MonthNumber). `chooseCandidates` finds the time
//          groupings partly by name, so renaming them would change which names
//          the model is SHOWN as well as what they are called — two variables
//          again, and the one it would test is the ranker's, not the model's.
//
//          The generated files are checked in. Regenerate and diff with
//          `--check`, exactly as `gen-sales-star.mjs` does.
//
// Usage:   node tests/fixtures/model/gen-renamed-star.mjs
//          node tests/fixtures/model/gen-renamed-star.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const SRC_MODEL = join(HERE, "sales_star.json");
const SRC_STRATEGY = join(HERE, "sales_star_strategy.json");
const SRC_CORPUS = join(REPO, "tests", "eval", "design-queries.json");

const OUT_MODEL = join(HERE, "renamed_star.json");
const OUT_STRATEGY = join(HERE, "renamed_star_strategy.json");
const OUT_CORPUS = join(REPO, "tests", "eval", "design-queries-renamed.json");

const check = process.argv.includes("--check");

/**
 * The identifier map: tables, columns and measures.
 *
 * Chosen to be a REAL vocabulary shift rather than a decoration. "Sales" ->
 * "Ledger2" would leave every English cue intact and measure nothing; a model
 * that has internalised "revenue lives in a table called Sales" must find no
 * purchase here. The words are ordinary business English so the task stays
 * fair — this tests vocabulary dependence, not obscurity.
 */
const IDENTS = new Map(
  Object.entries({
    // tables
    Sales: "Ledger",
    Product: "Item",
    Subcategory: "Line",
    Customer: "Account",
    Geography: "Territory",
    // columns
    ProductKey: "ItemKey",
    SubcategoryKey: "LineKey",
    SubcategoryName: "LineName",
    CustomerKey: "AccountKey",
    GeoKey: "TerritoryKey",
    Category: "Family",
    Segment: "Tier",
    Region: "Zone",
    Country: "Market",
    Amount: "Value",
    // measures
    Revenue: "NetValue",
    Cost: "Spend",
    Margin: "Surplus",
    MarginPct: "SurplusPct",
    Quantity: "Units",
    Customers: "Accounts",
  }),
);

/**
 * The prose map, for the INTENTS.
 *
 * The intents are what a person types, so they must move with the schema or the
 * task becomes unanswerable rather than merely renamed — "revenue by product
 * category" over a model with neither word is a different and unfair question.
 * Swedish is mapped too: 10 of the 40 tasks are Swedish and dropping them would
 * quietly halve the locale coverage of the second schema.
 */
const PROSE_EN = [
  // Longest first, so "product category" is rewritten before "product".
  ["product categories", "item families"],
  ["product category", "item family"],
  ["product name", "item title"],
  ["customer segments", "account tiers"],
  ["customer segment", "account tier"],
  ["revenue", "net value"],
  ["margin percent", "surplus percent"],
  ["margin", "surplus"],
  ["categories", "families"],
  ["category", "family"],
  ["segments", "tiers"],
  ["segment", "tier"],
  ["regions", "zones"],
  ["region", "zone"],
  ["countries", "markets"],
  ["country", "market"],
  ["customers", "accounts"],
  ["customer", "account"],
  ["products", "items"],
  ["product", "item"],
  ["quantity", "units"],
  ["cost", "spend"],
];

/**
 * Swedish, kept SEPARATE from English and applied only to Swedish tasks.
 *
 * ONE MAP FOR BOTH LANGUAGES DOES NOT WORK, and the first version proved it:
 * "region" is spelled identically in the two languages, so the English rule
 * fired on the Swedish intents and produced "per zone" — an English word inside
 * a Swedish sentence, which measures the model's tolerance for broken Swedish
 * rather than its grasp of a renamed schema.
 *
 * TWO THINGS THIS MAP HAS TO RESPECT THAT THE ENGLISH ONE DOES NOT:
 *
 *  1. GRAMMATICAL GENDER, because the corpus contains "andel av den totala
 *     omsättningen". `omsättning` is an EN-word, so a replacement must be one
 *     too or the definite article and the adjective both go wrong — the first
 *     attempt used `nettovärde` (ETT) and produced "den totala nettovärdet".
 *     `nettosumma` is en-gender and keeps the sentence grammatical.
 *
 *  2. COMPOUNDS. Swedish compounds are single words, so a word-boundary rule
 *     never reaches the parts: "produktkategori" survived the first pass
 *     untouched. Every compound the corpus actually uses is listed explicitly.
 *
 * A confound worth recording rather than hiding: `segment` is spelled the same
 * in both languages, so the original Swedish tasks got an identical-cognate
 * hint that `skikt` does not give. The Swedish half of this corpus is therefore
 * very slightly HARDER than the original, and the English half is the cleaner
 * comparison. Report the two separately.
 */
const PROSE_SV = [
  // Compounds first — they contain the simple words.
  ["produktkategorier", "artikelfamiljer"],
  ["produktkategori", "artikelfamilj"],
  ["kundsegment", "kontoskikt"],
  ["totalsummor", "totalsummor"], // unchanged: not domain vocabulary
  // Definite/plural forms before their stems.
  ["omsättningen", "nettosumman"],
  ["omsättning", "nettosumma"],
  ["kategorier", "familjer"],
  ["kategorin", "familjen"],
  ["kategori", "familj"],
  ["marginalen", "överskottet"],
  ["marginal", "överskott"],
  ["länderna", "marknaderna"],
  ["länder", "marknader"],
  ["landet", "marknaden"],
  ["land", "marknad"],
  ["kunderna", "kontona"],
  ["kunder", "konton"],
  ["kunden", "kontot"],
  ["kund", "konto"],
  ["produkterna", "artiklarna"],
  ["produkter", "artiklar"],
  ["produkten", "artikeln"],
  ["produkt", "artikel"],
  ["segmenten", "skikten"],
  ["segment", "skikt"],
  ["regionen", "zonen"],
  ["regioner", "zoner"],
  ["region", "zon"],
  ["kvantitet", "enheter"],
  ["kostnaden", "utgiften"],
  ["kostnad", "utgift"],
];

/** Rename every identifier in a string, as WHOLE words. */
function renameIdents(text) {
  let out = text;
  // Longest first: `SubcategoryKey` must be rewritten before `Subcategory`.
  const names = [...IDENTS.keys()].sort((a, b) => b.length - a.length);
  for (const from of names) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), IDENTS.get(from));
  }
  return out;
}

/** Rewrite a natural-language intent, preserving case of the first letter. */
function renameProse(text, lang) {
  let out = text;
  for (const [from, to] of lang === "sv" ? PROSE_SV : PROSE_EN) {
    out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
      m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to,
    );
  }
  return out;
}

/** Deep-rename every string in a JSON value with `fn`. */
function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

const model = JSON.parse(readFileSync(SRC_MODEL, "utf8"));
const strategy = JSON.parse(readFileSync(SRC_STRATEGY, "utf8"));
const corpus = JSON.parse(readFileSync(SRC_CORPUS, "utf8"));

const newModel = mapStrings(model, renameIdents);
const newStrategy = mapStrings(strategy, renameIdents);

const newCorpus = {
  ...corpus,
  $comment:
    "GENERATED by tests/fixtures/model/gen-renamed-star.mjs — do not hand-edit. " +
    "The same 40 tasks as design-queries.json over renamed_star.json: identical " +
    "structure, identical rows, identical semantics, different vocabulary. Its " +
    "only purpose is to answer whether a design-query score is about the DSL or " +
    "about sales_star's column names.",
  tasks: corpus.tasks.map((t) => ({
    ...t,
    // BOTH maps, identifiers first. Some intents name a column outright ("the
    // sum of the Amount column by year") or ask for an alias spelled like a
    // table ("headed Sales"), and prose rules keyed on lowercase domain words
    // never reach those. Identifiers first so `Amount` becomes `Value` before
    // any prose rule can see it.
    intent: renameProse(renameIdents(t.intent), t.lang),
    reference: renameIdents(t.reference),
    ...(t.distractor ? { distractor: renameIdents(t.distractor) } : {}),
    ...(t.alternatives ? { alternatives: t.alternatives.map(renameIdents) } : {}),
  })),
};

const files = [
  [OUT_MODEL, JSON.stringify(newModel, null, 2) + "\n"],
  [OUT_STRATEGY, JSON.stringify(newStrategy, null, 2) + "\n"],
  [OUT_CORPUS, JSON.stringify(newCorpus, null, 2) + "\n"],
];

if (check) {
  let drift = 0;
  for (const [path, text] of files) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = "";
    }
    if (existing !== text) {
      console.error(`DRIFT: ${path} differs from what the generator writes.`);
      drift++;
    }
  }
  if (drift) process.exit(1);
  console.log("[gen-renamed-star] --check: all three files match the generator.");
  process.exit(0);
}

for (const [path, text] of files) writeFileSync(path, text, "utf8");

// A rename that leaves an original name behind is a fixture that silently
// measures a MIXTURE of the two vocabularies, which is the one outcome that
// would make the comparison meaningless.
const leaked = [];
for (const [path, text] of files) {
  for (const from of IDENTS.keys()) {
    if (new RegExp(`\\b${from}\\b`).test(text)) leaked.push(`${path}: ${from}`);
  }
}
if (leaked.length) {
  console.error("LEAKED original identifiers:\n  " + leaked.join("\n  "));
  process.exit(1);
}

console.log(
  `[gen-renamed-star] wrote ${files.length} files; ${newCorpus.tasks.length} tasks renamed, ` +
    `no original identifier survives.`,
);

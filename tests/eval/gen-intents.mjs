//! FILENAME: tests/eval/gen-intents.mjs
// PURPOSE: Build `intents.json` — the corpus the intent router (AI programme M4)
//          is scored on — from text this repository already trusts.
// CONTEXT: `docs/design/ai-intent-router.md` says the corpus is Step 5's FIRST
//          deliverable, not the router: the design-query corpus preceded the
//          drafting loop, the fill-in-the-middle corpus preceded any FIM code,
//          and the citation check preceded the narrator. D5 says "each measured
//          before the next".
//
// WHERE THE TEXT COMES FROM, and why it is not invented:
//
//   tasks.json          37 requests written for the SCRIPT-authoring eval. In a
//                       chat most of them are NOT script requests at all —
//                       "make the header row bold" is formatting unless someone
//                       says "every time". That mismatch is the point: these are
//                       the genuinely confusable utterances the router exists to
//                       separate, and they were written by someone who was not
//                       thinking about routing, which is the best provenance a
//                       classification corpus can have.
//   design-queries.json 40 report requests, 10 of them Swedish. Clean `bi-query`.
//
// WHAT IS CURATED HERE, and is therefore judgement: the LABEL on each. A chat
// user asking "make the header bold" wants the outcome; the same person saying
// "make the header bold every time the sheet opens" wants a script. The label
// tables below record that judgement per utterance, with a one-line reason, so
// a disagreement is an argument about a line rather than about a number.
//
// `decisive: true` marks an utterance the DETERMINISTIC rules are expected to
// settle without a model. That subset is where the design pins 100 % precision:
// a rule that fires must never be wrong, even if many rules never fire.
//
// USAGE
//   node tests/eval/gen-intents.mjs            rewrite intents.json
//   node tests/eval/gen-intents.mjs --check    fail if the committed file drifted

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The nine intents the router chooses between. */
const INTENTS = [
  "formula",
  "format",
  "data-op",
  "analyze",
  "chart",
  "script",
  "bi-query",
  "question",
  "unclear",
];

/**
 * How each `tasks.json` request should route IN A CHAT.
 *
 * `[intent, decisive, confusableWith, why]`. A request signals `script` when it
 * asks for something DURABLE — a button click, a schedule, a remembered value, a
 * dialog, an exposed command, a form — and not merely because the outcome would
 * need code to achieve. That distinction is the one the measurements say a 3B
 * model cannot make ("a 3B model failing to distinguish a request for automation
 * from a request for the outcome, and no prompt wording tested here changed
 * it"), so it is the distinction the corpus is densest around.
 */
const SCRIPT_CORPUS_LABELS = {
  "grid-read-write-cell": ["script", true, "data-op", "a button click is durable, not a one-off edit"],
  "grid-sum-column": ["formula", true, "script", "asks for a formula in a cell, by name"],
  "grid-sum-in-script": ["script", true, "formula", "says 'in the script itself (not with a formula)'"],
  "grid-bold-header-row": ["format", true, "script", "a one-off appearance change"],
  "grid-used-range-report": ["question", false, "analyze", "wants a fact about the sheet, not a change"],
  "grid-sort-by-first-column": ["data-op", true, "script", "one sort, now"],
  "grid-find-and-replace": ["data-op", true, "script", "one replace across the sheet"],
  "grid-count-matches": ["question", false, "formula", "a count reported back; COUNTIF would also answer it"],
  "grid-add-sheet": ["data-op", true, "script", "one structural change"],
  "grid-create-table": ["data-op", true, "script", "one structural change"],
  "grid-recalculate": ["data-op", true, null, "a single command, no durability"],
  "grid-act-on-selection": ["format", true, "script", "appearance, applied once, to the selection"],
  "cap-storage-counter": ["script", true, null, "'remembering across sessions' is durable by definition"],
  "cap-fetch-rate": ["script", true, "data-op", "reaching the network needs a declared capability"],
  "cap-schedule-refresh": ["script", true, null, "'every 15 minutes' and 'after reopening'"],
  "cap-dialog-confirm-before-clearing": ["script", true, "data-op", "asks a question of the user at run time"],
  "cap-dialog-prompt-for-name": ["script", true, "data-op", "prompts the user at run time"],
  "cap-two-capabilities": ["script", true, null, "network plus remembered state"],
  "cap-form-customer-quantity": ["script", true, null, "a form is an authored object"],
  "obj-sheet-context": ["script", true, null, "'whenever this sheet is used' is a lifecycle hook"],
  "obj-workbook-context": ["script", true, null, "'expose a command' is durable"],
  "obj-named-range-values": ["script", false, "question", "'log' implies code; the ask itself is a read"],
  "trap-vba-cells-idiom": ["data-op", true, "script", "setting one cell is the outcome, not automation"],
  "trap-office-js-idiom": ["script", true, "question", "'show it to the user in a message' needs a dialog"],
  "trap-console-log": ["script", true, "question", "logging for debugging is a script activity"],
  "trap-undeclared-capability": ["script", true, null, "'survives reopening' is stored state"],
  "trap-browser-fetch": ["script", true, "data-op", "network access needs a capability"],
  "trap-window-alert": ["script", true, null, "a pop-up message needs a dialog capability"],
  "shape-multi-step-report": ["data-op", false, "format", "several one-off edits, one of them formatting"],
  "shape-guard-empty-input": ["data-op", false, "script", "conditional, but still once"],
  "shape-loop-over-rows": ["data-op", false, "formula", "a rule over a range; an IF formula also answers it"],
  "shape-format-number-columns": ["format", true, null, "a number format over a range"],
  "shape-named-handler": ["script", true, null, "'expose two commands' is durable"],
  "shape-report-errors": ["script", false, "data-op", "'tell the user if something goes wrong' needs code"],
  "shape-read-format-back": ["script", false, "question", "'log the answer' implies code"],
  "shape-formula-read": ["data-op", false, "formula", "copies an existing formula; one edit"],
  "shape-no-capability-needed": ["data-op", false, "formula", "writing today's date; =TODAY() also answers it"],
};

/**
 * Utterances no existing corpus supplies: the intents with no corpus of their
 * own (`analyze`, `chart`, `question`, `unclear`, `format`, `formula`), more
 * Swedish, and the REGRESSION cases for the defects a read of the current
 * detectors turned up.
 */
const WRITTEN = [
  // -- analyze ------------------------------------------------------------
  ["an-1", "en", "analyse this data", "analyze", true, null, "the word the existing detector already matches"],
  ["an-2", "en", "what is going on with these numbers", "analyze", true, "question", "a reported phrase; asks the data to explain itself"],
  ["an-3", "en", "anything unusual in this range?", "analyze", true, null, "outlier language without the word"],
  ["an-4", "en", "are there any outliers in column C", "analyze", true, null, "names the statistic"],
  ["an-5", "en", "is there a trend in the last twelve months", "analyze", true, "bi-query", "trend is an analysis word; 'last twelve months' is not a grouping"],
  ["an-6", "en", "explain these numbers to me", "analyze", true, "question", "a reported phrase"],
  ["an-7", "en", "what stands out here", "analyze", false, "question", "vague, but the analysis phrase list carries it"],
  ["an-8", "en", "check whether spend and leads move together", "analyze", true, null, "correlation without the word"],
  ["an-sv-1", "sv", "analysera det här området", "analyze", true, null, "Swedish for the same request"],
  ["an-sv-2", "sv", "finns det några avvikelser i kolumn C", "analyze", true, null, "avvikelse is in the Swedish word list"],
  ["an-sv-3", "sv", "vad säger de här siffrorna", "analyze", false, "question", "Swedish 'what do these numbers say'"],
  ["an-sv-4", "sv", "visa mönster i försäljningen över tid", "analyze", true, "bi-query", "mönster is an analysis word; 'över tid' pulls toward a report"],

  // -- formula ------------------------------------------------------------
  ["fo-1", "en", "=SUM(B2:B100)", "formula", true, null, "a leading equals sign is decisive on its own"],
  ["fo-2", "en", "what formula gives the average of column D ignoring blanks", "formula", true, null, "asks for a formula by name"],
  ["fo-3", "en", "write a formula to look up the price for the product in A2", "formula", true, "script", "'write a formula' is explicit"],
  ["fo-4", "en", "why does C7 show #DIV/0!", "formula", true, "question", "an error in a cell is formula territory"],
  ["fo-5", "en", "explain the formula in C10", "formula", true, "question", "explicitly about a formula"],
  ["fo-6", "en", "how do I count cells that are not empty", "formula", false, "question", "a how-to that a formula answers"],
  ["fo-sv-1", "sv", "vilken formel ger medelvärdet av kolumn D", "formula", true, null, "Swedish, asks for a formula"],
  ["fo-sv-2", "sv", "förklara formeln i C10", "formula", true, "question", "Swedish, explicitly about a formula"],

  // -- format -------------------------------------------------------------
  ["fm-1", "en", "make A1:D1 bold", "format", true, null, "appearance only"],
  ["fm-2", "en", "give the totals row a light grey background", "format", true, null, "appearance only"],
  ["fm-3", "en", "show column E as a percentage with one decimal", "format", true, "formula", "a number format, not a calculation"],
  ["fm-4", "en", "centre the headers and freeze the top row", "format", true, "data-op", "alignment plus a view setting"],
  ["fm-5", "en", "colour any cell over 100 red", "format", false, "script", "conditional formatting, not automation"],
  ["fm-sv-1", "sv", "gör rubrikraden fet", "format", true, null, "Swedish, appearance only"],
  ["fm-sv-2", "sv", "visa kolumn E som procent med en decimal", "format", true, "formula", "Swedish number format"],

  // -- chart --------------------------------------------------------------
  ["ch-1", "en", "make a line chart of revenue by month", "chart", true, "bi-query", "names the chart type"],
  ["ch-2", "en", "plot these two columns against each other", "chart", true, null, "'plot' is chart language"],
  ["ch-3", "en", "add a trendline to the sales chart", "chart", true, "analyze", "a chart object change; 'trend' is nearby"],
  ["ch-4", "en", "which chart type suits this data", "chart", false, "question", "advice about charts"],
  ["ch-sv-1", "sv", "gör ett linjediagram över omsättning per månad", "chart", true, "bi-query", "Swedish, names the chart type"],
  ["ch-sv-2", "sv", "lägg till en trendlinje i diagrammet", "chart", true, "analyze", "Swedish chart object change"],

  // -- data-op ------------------------------------------------------------
  ["do-1", "en", "delete the empty rows between 40 and 60", "data-op", true, null, "one structural edit"],
  ["do-2", "en", "split column A into first and last name", "data-op", true, null, "text to columns"],
  ["do-3", "en", "remove duplicate rows keeping the first", "data-op", true, null, "one clean-up"],
  ["do-sv-1", "sv", "ta bort dubbletter och behåll den första", "data-op", true, null, "Swedish, one clean-up"],
  ["do-sv-2", "sv", "sortera raderna efter kolumn A stigande", "data-op", true, "script", "Swedish sort"],

  // -- script -------------------------------------------------------------
  ["sc-1", "en", "every time this sheet opens, refresh the totals", "script", true, "data-op", "'every time' is the durability signal"],
  ["sc-2", "en", "write a macro that emails the summary when I click the button", "script", true, null, "macro plus a click handler"],
  ["sc-sv-1", "sv", "skriv ett makro som uppdaterar totalerna varje gång arket öppnas", "script", true, "data-op", "Swedish, macro plus a lifecycle hook"],
  ["sc-sv-2", "sv", "när knappen klickas, kopiera A1 till B1", "script", true, "data-op", "Swedish button click"],

  // -- question -----------------------------------------------------------
  ["qu-1", "en", "what does a pivot table do", "question", true, null, "a question about the product"],
  ["qu-2", "en", "how do I share this workbook with my team", "question", true, null, "a how-to with no cell target"],
  ["qu-3", "en", "can Calcula open an Excel file", "question", true, null, "a capability question"],
  ["qu-sv-1", "sv", "vad gör en pivottabell", "question", true, null, "Swedish product question"],
  ["qu-sv-2", "sv", "hur delar jag den här arbetsboken", "question", true, null, "Swedish how-to"],

  // -- unclear ------------------------------------------------------------
  ["un-1", "en", "fix this", "unclear", true, null, "no object, no verb that names a surface"],
  ["un-2", "en", "the numbers look wrong", "unclear", false, "analyze", "a complaint; could be analysis or a formula error"],
  ["un-3", "en", "can you help", "unclear", true, null, "no content at all"],
  ["un-4", "en", "do the thing we discussed", "unclear", true, null, "refers to context the router does not have"],
  ["un-sv-1", "sv", "fixa det här", "unclear", true, null, "Swedish, no object"],
  ["un-sv-2", "sv", "kan du hjälpa mig", "unclear", true, null, "Swedish, no content"],

  // -- more Swedish -------------------------------------------------------
  // The design asks for at least 40 Swedish utterances, and they are not
  // translations for their own sake: the existing detectors already carry a
  // Swedish analysis vocabulary and nothing else does, so Swedish is where a
  // rule table is most likely to be thin and a model most likely to be leaned
  // on. Spread across the intents that had one Swedish example or none.
  ["sv-fo-1", "sv", "=SUMMA(B2:B100)", "formula", true, null, "a leading equals sign, with the Swedish function name"],
  ["sv-fo-2", "sv", "hur räknar jag celler som inte är tomma", "formula", false, "question", "a how-to a formula answers"],
  ["sv-fo-3", "sv", "varför visar C7 #DIVISION/0!", "formula", true, "question", "a Swedish error literal in a cell"],
  ["sv-fm-1", "sv", "centrera rubrikerna och lås översta raden", "format", true, "data-op", "alignment plus a view setting"],
  ["sv-fm-2", "sv", "färga celler över 100 röda", "format", false, "script", "conditional formatting, not automation"],
  ["sv-do-1", "sv", "dela kolumn A i förnamn och efternamn", "data-op", true, null, "text to columns"],
  ["sv-do-2", "sv", "ta bort tomma rader mellan 40 och 60", "data-op", true, null, "one structural edit"],
  ["sv-do-3", "sv", "skapa ett nytt blad som heter Sammanfattning", "data-op", true, "script", "one structural change"],
  ["sv-sc-1", "sv", "fråga användaren innan A1:D100 rensas", "script", true, "data-op", "asks the user at run time"],
  ["sv-sc-2", "sv", "uppdatera totalerna var femtonde minut", "script", true, "data-op", "a schedule is durable"],
  ["sv-sc-3", "sv", "gör ett formulär med kundnamn bundet till B2", "script", true, null, "a form is an authored object"],
  ["sv-qu-1", "sv", "kan Calcula öppna en Excel-fil", "question", true, null, "a capability question"],
  ["sv-qu-2", "sv", "hur stor är datamängden på det här bladet", "question", false, "analyze", "wants a fact about the sheet"],
  ["sv-ch-1", "sv", "vilken diagramtyp passar den här datan", "chart", false, "question", "advice about charts"],
  ["sv-un-1", "sv", "siffrorna ser fel ut", "unclear", false, "analyze", "a complaint; analysis or a formula error"],
  ["sv-an-1", "sv", "hänger utgifterna ihop med antalet leads", "analyze", true, null, "correlation without the word"],

  // -- the confusable pairs the design names a target for -----------------
  // `script/format confusion <= 3%` is a stated target, so that pair is
  // deliberately dense. The other pairs are left at whatever the real corpora
  // produced: padding all sixteen to ten each would mean inventing utterances
  // nobody would type, and a corpus whose hard cases are imaginary reports a
  // precision about imagination.
  ["pf-1", "en", "bold the header row every time new data is imported", "script", true, "format", "formatting, but automated"],
  ["pf-2", "en", "make overdue rows red whenever the status column changes", "script", true, "format", "formatting, but on an event"],
  ["pf-3", "en", "apply our house number format to this sheet", "format", true, "script", "a one-off style application"],
  ["pf-4", "en", "add a button that formats the selection as currency", "script", true, "format", "a button is an authored object"],
  ["pf-5", "en", "reformat these dates as YYYY-MM-DD", "format", true, "script", "one number-format change"],
  ["pf-sv-1", "sv", "gör rubrikraden fet varje gång data importeras", "script", true, "format", "Swedish: formatting, automated"],
  ["pf-sv-2", "sv", "formatera om datumen som ÅÅÅÅ-MM-DD", "format", true, "script", "Swedish: one format change"],

  ["pq-1", "en", "is there a function for the median", "formula", true, "question", "asks whether a function exists"],
  ["pq-2", "en", "what does VLOOKUP's last argument do", "formula", true, "question", "about a formula's semantics"],
  ["pq-3", "en", "should I use SUMIF or SUMPRODUCT here", "formula", true, "question", "choosing between two functions"],
  ["pq-sv-1", "sv", "finns det en funktion för median", "formula", true, "question", "Swedish: does a function exist"],

  ["pa-1", "en", "is this month better or worse than last month", "analyze", true, "question", "a comparison the data answers"],
  ["pa-2", "en", "how healthy does this look to you", "analyze", false, "question", "vague, but asks the data to speak"],
  ["pa-3", "en", "summarise what changed this quarter", "analyze", true, "question", "a summary of the data, not of the product"],
  ["pa-sv-1", "sv", "är den här månaden bättre eller sämre än förra", "analyze", true, "question", "Swedish comparison"],

  // -- REGRESSIONS for the defects found in the current detectors ----------
  // Each of these is currently routed WRONGLY by `scriptIntent.ts`, which
  // matches its trigger list with `String.includes` although the same file
  // documents that `includes` "was WRONG". They are in the corpus so the fix
  // is measured rather than asserted.
  ["rg-description", "en", "add a description to the chart", "chart", true, "script", "'description' contains 'script' — must not fire the script offer"],
  ["rg-subscription", "en", "put the subscription total in B4", "data-op", true, "script", "'subscription' contains 'script'"],
  ["rg-transcript", "en", "paste the transcript into column A", "data-op", true, "script", "'transcript' contains 'script'"],
  ["rg-prescription", "en", "format the prescription column as text", "format", true, "script", "'prescription' contains 'script'"],
  ["rg-macroeconomic", "en", "chart the macroeconomic indicators by quarter", "chart", true, "script", "'macroeconomic' contains 'macro'"],
  ["rg-adjust", "en", "adjust the totals automatically whenever the source changes", "script", true, "data-op", "'adjust' contains 'just ' — the suppressor must not fire"],
  ["rg-readjust", "en", "readjust the column widths every time the data loads", "script", true, "format", "'readjust' contains 'just '"],
  ["rg-both", "en", "write a macro that flags outliers every month", "script", true, "analyze", "matches BOTH detectors today; the router must pick one"],
  ["rg-both-2", "en", "analyse the sales and then automate the report every week", "script", false, "analyze", "genuinely two requests; the design says ask"],
];

function build() {
  const read = (rel) => JSON.parse(readFileSync(path.join(here, rel), "utf8"));
  const scripts = read("tasks.json");
  const queries = read("design-queries.json");
  const utterances = [];

  for (const task of scripts.tasks ?? scripts) {
    const label = SCRIPT_CORPUS_LABELS[task.id];
    if (!label) throw new Error(`tasks.json has an unlabelled request: ${task.id}`);
    const [intent, decisive, confusableWith, why] = label;
    utterances.push({
      id: `task:${task.id}`,
      lang: "en",
      text: task.intent,
      intent,
      decisive,
      confusableWith,
      why,
      source: `tasks.json#${task.id}`,
    });
  }

  for (const task of queries.tasks) {
    utterances.push({
      id: `dq:${task.id}`,
      lang: task.lang === "sv" ? "sv" : "en",
      text: task.intent,
      intent: "bi-query",
      // A report request names a measure and a grouping; that is what makes it
      // separable from `analyze`, which names a statistic instead.
      decisive: true,
      confusableWith: "analyze",
      why: "names a measure and a grouping — a report, not a statistic",
      source: `design-queries.json#${task.id}`,
    });
  }

  for (const [id, lang, text, intent, decisive, confusableWith, why] of WRITTEN) {
    utterances.push({ id, lang, text, intent, decisive, confusableWith, why, source: "written" });
  }

  const seen = new Set();
  for (const u of utterances) {
    if (!INTENTS.includes(u.intent)) throw new Error(`${u.id}: unknown intent ${u.intent}`);
    if (u.confusableWith && !INTENTS.includes(u.confusableWith)) {
      throw new Error(`${u.id}: unknown confusable ${u.confusableWith}`);
    }
    const key = u.text.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate utterance: ${u.text}`);
    seen.add(key);
  }

  return { version: 1, intents: INTENTS, utterances };
}

const corpus = build();
const target = path.join(here, "intents.json");
const text = JSON.stringify(corpus, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error(`intents.json is missing. Run: node tests/eval/gen-intents.mjs`);
    process.exit(1);
  }
  if (current !== text) {
    console.error(`intents.json is stale. Run: node tests/eval/gen-intents.mjs`);
    process.exit(1);
  }
  console.log(`[intents] up to date: ${corpus.utterances.length} utterances`);
} else {
  writeFileSync(target, text, "utf8");
  const byIntent = {};
  const byLang = {};
  let decisive = 0;
  for (const u of corpus.utterances) {
    byIntent[u.intent] = (byIntent[u.intent] ?? 0) + 1;
    byLang[u.lang] = (byLang[u.lang] ?? 0) + 1;
    if (u.decisive) decisive++;
  }
  console.log(`[intents] wrote ${corpus.utterances.length} utterances to intents.json`);
  console.log(`[intents] by intent: ${Object.entries(byIntent).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`[intents] by language: ${Object.entries(byLang).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`[intents] decisive subset (100% precision is pinned here): ${decisive}`);
}

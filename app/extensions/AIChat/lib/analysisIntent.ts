//! FILENAME: app/extensions/AIChat/lib/analysisIntent.ts
// PURPOSE: Notice when a chat message is really a question about WHAT IS GOING
//          ON in the data, so the chat can compute the facts first (Tier 0,
//          no model) and hand the model a checked bundle to put into words.
// CONTEXT: 2026-09-10. Asked "what is going on with revenue?", a chat model
//          reads raw cells and forms an impression — the one job it is least
//          reliable at, and the reason Calcula has a deterministic insights
//          engine at all. That engine answers in a quarter of a second and
//          needs no model, so the cheapest correct move is to run it BEFORE
//          the model sees the message and put its facts in front of the model.
//
//          DELIBERATELY NOT A CLASSIFIER, for the same reason `scriptIntent.ts`
//          is not one: asking the model whether this is an analysis question
//          spends a round trip on the judgement it is bad at. A word list is
//          worse at the margins and completely legible at the centre, and the
//          cost of a false positive here is one cheap read-only computation
//          the model may simply not use. The cost of a false negative is the
//          old behaviour: the model can still call `analyze_range` itself.
//
//          Single words are matched as WORDS (`mentionsWord`), never as
//          substrings: "trend" must not fire on "trendy" any more than "sheet"
//          may fire on "spreadsheet" — the lesson `scriptIntent.ts` paid for.
//          Multi-word phrases are matched as substrings, because a phrase
//          boundary is already a word boundary at both ends.

import { mentionsWord } from "./scriptIntent";

/** Single words that mean "tell me what the data says". English and Swedish. */
const ANALYSIS_WORDS = [
  "analyse", "analyze", "analysis", "analysing", "analyzing",
  "insight", "insights",
  "trend", "trends", "trending",
  "outlier", "outliers", "anomaly", "anomalies",
  "correlation", "correlations", "correlate", "correlated",
  "seasonality", "seasonal",
  // Swedish
  "analysera", "analys", "insikt", "insikter",
  "utveckling", "avvikelse", "avvikelser", "mönster", "säsongsmönster",
];

/** Phrases, matched as substrings because they are several words long. */
const ANALYSIS_PHRASES = [
  "what is going on", "what's going on", "whats going on",
  "what is happening", "what's happening", "whats happening",
  "what happened",
  "what stands out", "anything interesting", "anything unusual", "anything notable",
  "explain the data", "explain this data", "explain these numbers", "explain the numbers",
  "explain this range", "explain the selection", "explain this chart",
  "summarise the data", "summarize the data", "summarise this data", "summarize this data",
  "summarise the numbers", "summarize the numbers",
  "tell me about this data", "tell me about the data", "describe this data", "describe the data",
  // Swedish
  "vad händer", "vad har hänt", "vad hände",
  "förklara siffrorna", "förklara datan", "sammanfatta datan", "sammanfatta siffrorna",
  "sticker ut", "något intressant", "hur går det", "hur har det gått",
];

/**
 * Words that say the message is about something ELSE that happens to share
 * vocabulary. "A formula for the trend" wants the formula assistant, not a fact
 * bundle, and the formula seam is the better answer to it.
 */
const NOT_ANALYSIS_WORDS = ["formula", "formulas", "formel", "formler"];

export interface AnalysisIntent {
  /** True when the message reads as a question about what the data says. */
  looksLikeAnalysis: boolean;
  /** The word or phrase that matched, for an honest note to the user. */
  matched: string | null;
}

export function detectAnalysisIntent(message: string): AnalysisIntent {
  const text = message.toLowerCase();
  if (NOT_ANALYSIS_WORDS.some((w) => mentionsWord(text, w))) {
    return { looksLikeAnalysis: false, matched: null };
  }
  const word = ANALYSIS_WORDS.find((w) => mentionsWord(text, w));
  if (word) return { looksLikeAnalysis: true, matched: word };
  const phrase = ANALYSIS_PHRASES.find((p) => text.includes(p));
  if (phrase) return { looksLikeAnalysis: true, matched: phrase };
  return { looksLikeAnalysis: false, matched: null };
}

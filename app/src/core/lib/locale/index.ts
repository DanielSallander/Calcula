//! FILENAME: app/src/core/lib/locale/index.ts
// PURPOSE: Barrel for the pure locale module (number/date text + the active locale).
// CONTEXT: P2 (app locale everywhere). Extensions reach this through `@api/locale`.

export type {
  LocaleSettings,
  DateStyle,
  FormatNumberOptions,
  CodeFormatResult,
} from "./localeText";
export {
  formatNumberIn,
  formatNumberWithCodeIn,
  formatDateIn,
  parseNumberIn,
  parseDateIn,
  dateToSerial,
  datePatternFor,
  monthNameIn,
  dayNameIn,
  quarterLabelIn,
} from "./localeText";
export {
  INVARIANT_LOCALE,
  normalizeLocaleSettings,
  getActiveLocale,
  setActiveLocale,
  subscribeActiveLocale,
  resetActiveLocaleForTests,
} from "./activeLocale";

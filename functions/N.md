# N function

## Introduction

The N function converts a value to a number. It is primarily a compatibility function that translates different data types into their numeric equivalents according to specific rules.

Use N when you need to ensure a value is treated as a number in calculations. Numbers are returned unchanged, dates return their serial number, TRUE returns 1, FALSE returns 0, and all other values (including text and errors) return 0. While rarely needed in modern formulas, N is sometimes used for adding inline comments to formulas or for explicit type conversion.

## Syntax

```
=N(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value to convert to a number. |

### Conversion rules

| Value Type | Result |
|-----------|--------|
| Number | The number itself |
| Date | The date serial number |
| TRUE | 1 |
| FALSE | 0 |
| Error | The error value |
| Text | 0 |

## Remarks

- N is generally not needed in formulas because most operations perform implicit type conversion.
- One common use of N is adding comments within formulas: `=A1+B1+N("Tax included")` -- the N("Tax included") evaluates to 0 and serves as a human-readable note.
- Error values are passed through unchanged (e.g., N(#REF!) returns #REF!).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **N Result** |
| 2 | 42 | =N(A2) |
| 3 | TRUE | =N(A3) |
| 4 | Hello | =N(A4) |

**Result (B2):** 42
**Result (B3):** 1
**Result (B4):** 0

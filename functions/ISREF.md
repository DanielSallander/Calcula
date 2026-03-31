# ISREF function

## Introduction

The ISREF function returns TRUE if the specified value is a reference. This is useful for checking whether an argument passed to a formula is a cell or range reference.

## Syntax

```
=ISREF(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value to check. |

## Remarks

- Returns TRUE for cell references (e.g., A1) and range references (e.g., A1:B5).
- Returns FALSE for literal values, text, numbers, and other non-reference expressions.

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Result** |
| 2 | =ISREF(A1) | TRUE |
| 3 | =ISREF(42) | FALSE |
| 4 | =ISREF("text") | FALSE |

**Result:** Only cell references return TRUE.

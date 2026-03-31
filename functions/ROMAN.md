# ROMAN function

## Introduction

The ROMAN function converts an Arabic numeral to a Roman numeral as text. For example, ROMAN(499) returns "CDXCIX".

## Syntax

```
=ROMAN(number, [form])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The Arabic numeral to convert. Must be between 0 and 3999. |
| form | Optional | The type of Roman numeral (classic form is used). |

## Remarks

- If number is 0, an empty string is returned.
- If number is negative or greater than 3999, a #VALUE! error is returned.

## Example

| | A | B |
|---|---|---|
| 1 | **Number** | **Roman** |
| 2 | 499 | =ROMAN(A2) |
| 3 | 2023 | =ROMAN(A3) |

**Result:** Cell B2 returns **"CDXCIX"** and cell B3 returns **"MMXXIII"**.

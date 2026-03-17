# COLUMNS function

## Introduction

The COLUMNS function returns the number of columns in a reference or array. It is a utility function that counts how many columns a given range spans.

Use COLUMNS when you need to determine the width of a range dynamically, such as when building adaptive formulas or validating that a range meets expected dimensions. It pairs well with ROWS for fully describing the shape of a data range.

## Syntax

```
=COLUMNS(array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | A range, array, or reference whose number of columns you want to count. |

## Remarks

- COLUMNS counts the total number of columns in the range, including empty columns.
- When used with an array constant, COLUMNS counts the number of columns in the array.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | Name | Age | City | Score |
| 2 | | | | |
| 3 | **Result** | =COLUMNS(A1:D1) | | |

**Result (B3):** 4

The formula returns 4 because the range A1:D1 spans four columns (A through D).

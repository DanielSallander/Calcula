# ROWS function

## Introduction

The ROWS function returns the number of rows in a reference or array. It is a simple utility function that counts how many rows a given range spans.

Use ROWS to dynamically determine the size of a range, which is helpful when building formulas that need to adapt to varying data sizes. It is commonly used with OFFSET, INDEX, and other functions to create self-adjusting ranges and formulas.

## Syntax

```
=ROWS(array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | A range, array, or reference whose number of rows you want to count. |

## Remarks

- ROWS counts the total number of rows in the range, regardless of whether the cells contain data or are empty.
- When used with an array constant, ROWS counts the number of rows in the array.

## Example

| | A | B |
|---|---|---|
| 1 | **Data** | |
| 2 | 10 | |
| 3 | 20 | |
| 4 | 30 | |
| 5 | 40 | |
| 6 | | |
| 7 | **Result** | =ROWS(A2:A5) |

**Result (B7):** 4

The formula returns 4 because the range A2:A5 spans four rows.

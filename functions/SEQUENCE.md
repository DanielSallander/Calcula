# SEQUENCE function

## Introduction
The SEQUENCE function generates a list of sequential numbers in an array. You can specify the number of rows and columns, the starting value, and the step increment.

SEQUENCE is a dynamic array function that creates number sequences without manual data entry. It is useful for generating row numbers, indices, date series, and other evenly spaced numeric patterns.

## Syntax
```
=SEQUENCE(rows, [columns], [start], [step])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| rows | Required | The number of rows to return. Must be 1 or greater. |
| columns | Optional | The number of columns to return. Default is 1. Must be 1 or greater. |
| start | Optional | The first number in the sequence. Default is 1. |
| step | Optional | The increment between each number. Default is 1. Can be negative or decimal. |

## Remarks
- The result spills into adjacent cells. If any spill cell is occupied, the formula returns a #SPILL! error.
- The total number of values generated is rows x columns.
- Values fill across each row first, then move to the next row (row-major order).
- If rows and columns are both 1, a single number (the start value) is returned.

## Example 1 - Simple sequence

| | A |
|---|---|
| 1 | **Result** |
| 2 | =SEQUENCE(5) |

**Result (A2:A6):**
1, 2, 3, 4, 5

The formula generates 5 sequential numbers starting from 1.

## Example 2 - Grid of numbers

| | A | B | C |
|---|---|---|---|
| 1 | **Result** | | |
| 2 | =SEQUENCE(3, 3) | | |

**Result (A2:C4):**
| 1 | 2 | 3 |
| 4 | 5 | 6 |
| 7 | 8 | 9 |

The formula creates a 3x3 grid filled with numbers 1 through 9.

## Example 3 - Custom start and step

| | A |
|---|---|
| 1 | **Result** |
| 2 | =SEQUENCE(4, 1, 10, 5) |

**Result (A2:A5):**
10, 15, 20, 25

The formula generates 4 numbers starting at 10 with a step of 5.

## Example 4 - Descending sequence

| | A |
|---|---|
| 1 | **Result** |
| 2 | =SEQUENCE(5, 1, 100, -10) |

**Result (A2:A6):**
100, 90, 80, 70, 60

Using a negative step creates a descending sequence.

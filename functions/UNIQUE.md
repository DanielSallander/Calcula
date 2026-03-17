# UNIQUE function

## Introduction
The UNIQUE function returns a list of unique values from a range or array. It removes duplicate entries and returns the result as a dynamic array that spills into adjacent cells.

UNIQUE is a dynamic array function useful for extracting distinct values from a dataset without manual deduplication. It can operate on rows or columns and optionally return only values that appear exactly once.

## Syntax
```
=UNIQUE(array, [by_col], [exactly_once])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array from which to extract unique values. |
| by_col | Optional | A Boolean value. FALSE (default) compares rows for uniqueness. TRUE compares columns. |
| exactly_once | Optional | A Boolean value. FALSE (default) returns all distinct values. TRUE returns only values that appear exactly once in the array. |

## Remarks
- The result spills into adjacent cells. If any spill cell is occupied, the formula returns a #SPILL! error.
- When comparing multi-column rows, two rows are considered duplicates only if all corresponding cells match.
- Comparison is case-insensitive for text values.
- The order of first appearance is preserved in the output.

## Example 1 - Basic unique values

| | A |
|---|---|
| 1 | **Fruit** |
| 2 | Apple |
| 3 | Banana |
| 4 | Apple |
| 5 | Cherry |
| 6 | Banana |
| 7 | **Result** |
| 8 | =UNIQUE(A2:A6) |

**Result (A8:A10):**
Apple, Banana, Cherry

The formula returns each fruit name once, in order of first appearance.

## Example 2 - Unique rows (multi-column)

| | A | B |
|---|---|---|
| 1 | **Name** | **Dept** |
| 2 | Alice | Sales |
| 3 | Bob | Marketing |
| 4 | Alice | Sales |
| 5 | Carol | Sales |
| 6 | **Result** | |
| 7 | =UNIQUE(A2:B5) | |

**Result (A7:B9):**
| Alice | Sales |
| Bob | Marketing |
| Carol | Sales |

The duplicate row "Alice, Sales" is removed.

## Example 3 - Exactly once

| | A |
|---|---|
| 1 | **Color** |
| 2 | Red |
| 3 | Blue |
| 4 | Red |
| 5 | Green |
| 6 | Blue |
| 7 | Yellow |
| 8 | **Result** |
| 9 | =UNIQUE(A2:A7, FALSE, TRUE) |

**Result (A9:A10):**
Green, Yellow

With exactly_once set to TRUE, only values that appear exactly once (Green and Yellow) are returned. Red and Blue appear twice and are excluded.

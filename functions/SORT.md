# SORT function

## Introduction
The SORT function sorts the contents of a range or array. It returns a sorted copy of the data as a dynamic array that spills into adjacent cells.

SORT is a dynamic array function that replaces manual sort operations with a formula-based approach. The original data remains unchanged; the sorted result appears wherever the formula is entered.

## Syntax
```
=SORT(array, [sort_index], [sort_order], [by_col])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array to sort. |
| sort_index | Optional | A number indicating which column (or row) to sort by. Default is 1 (first column or row). |
| sort_order | Optional | 1 for ascending (default), -1 for descending. |
| by_col | Optional | A Boolean value. FALSE (default) sorts by rows. TRUE sorts by columns. |

## Remarks
- The result spills into adjacent cells. If any spill cell is occupied, the formula returns a #SPILL! error.
- Numbers sort before text, which sorts before Booleans, which sort before errors (matching Excel behavior).
- Text sorting is case-insensitive.
- SORT can be combined with FILTER: `=SORT(FILTER(A1:C10, B1:B10>50), 3, -1)` filters then sorts by column 3 descending.

## Example 1 - Sort a single column ascending

| | A |
|---|---|
| 1 | **Score** |
| 2 | 85 |
| 3 | 42 |
| 4 | 97 |
| 5 | 63 |
| 6 | **Result** |
| 7 | =SORT(A2:A5) |

**Result (A7:A10):**
42, 63, 85, 97

The formula sorts the scores in ascending order (default).

## Example 2 - Sort by a specific column descending

| | A | B |
|---|---|---|
| 1 | **Name** | **Sales** |
| 2 | Alice | 300 |
| 3 | Bob | 150 |
| 4 | Carol | 450 |
| 5 | **Result** | |
| 6 | =SORT(A2:B4, 2, -1) | |

**Result (A6:B8):**
| Carol | 450 |
| Alice | 300 |
| Bob | 150 |

The formula sorts the data by column 2 (Sales) in descending order.

## Example 3 - Sort columns (horizontal sort)

| | A | B | C |
|---|---|---|---|
| 1 | **Q3** | **Q1** | **Q2** |
| 2 | 300 | 100 | 200 |
| 3 | **Result** | | |
| 4 | =SORT(A1:C2, 1, 1, TRUE) | | |

**Result (A4:C5):**
| Q1 | Q2 | Q3 |
| 100 | 200 | 300 |

With by_col set to TRUE, the columns are rearranged so that row 1 (the headers) is in ascending alphabetical order.

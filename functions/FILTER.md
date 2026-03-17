# FILTER function

## Introduction
The FILTER function filters a range of data based on criteria you define. It returns an array of values from the rows (or columns) that meet the specified condition, automatically spilling results into adjacent cells.

FILTER is a dynamic array function, meaning its result can span multiple cells. It is ideal for extracting subsets of data without helper columns or complex INDEX/MATCH combinations.

## Syntax
```
=FILTER(array, include, [if_empty])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array to filter. |
| include | Required | A Boolean array (TRUE/FALSE) with the same number of rows (or columns) as the array. Only rows where the corresponding include value is TRUE are returned. |
| if_empty | Optional | The value to return if no rows match the criteria. If omitted and no matches exist, a #VALUE! error is returned. |

## Remarks
- The include argument is typically a comparison expression like `A2:A10="Apple"` or `B2:B10>100`.
- If include has the same number of rows as array, filtering is done by rows. If it has the same number of columns, filtering is done by columns.
- The result spills into adjacent cells below (and to the right for multi-column results). If any spill cell is already occupied, the formula returns a #SPILL! error.
- FILTER can be combined with SORT to return sorted filtered results: `=SORT(FILTER(...))`.

## Example 1 - Filter by text match

| | A | B |
|---|---|---|
| 1 | **Fruit** | **Price** |
| 2 | Apple | 1.20 |
| 3 | Banana | 0.50 |
| 4 | Apple | 1.50 |
| 5 | Cherry | 3.00 |
| 6 | **Result** | |
| 7 | =FILTER(A2:B5, A2:A5="Apple") | |

**Result (A7:B8):**
| Apple | 1.20 |
| Apple | 1.50 |

The formula returns all rows where column A equals "Apple".

## Example 2 - Filter by numeric condition

| | A | B |
|---|---|---|
| 1 | **Product** | **Sales** |
| 2 | Widget | 150 |
| 3 | Gadget | 80 |
| 4 | Gizmo | 200 |
| 5 | Doohickey | 50 |
| 6 | **Result** | |
| 7 | =FILTER(A2:B5, B2:B5>100) | |

**Result (A7:B8):**
| Widget | 150 |
| Gizmo | 200 |

The formula returns rows where Sales exceed 100.

## Example 3 - Custom if_empty message

| | A |
|---|---|
| 1 | **Name** |
| 2 | Alice |
| 3 | Bob |
| 4 | **Result** |
| 5 | =FILTER(A2:A3, A2:A3="Charlie", "No matches") |

**Result:** "No matches"

Because no cell contains "Charlie", the if_empty value is returned instead of an error.

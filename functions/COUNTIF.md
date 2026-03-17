# COUNTIF function

## Introduction
The COUNTIF function counts the number of cells in a range that meet a single condition. It is one of the most frequently used analytical functions, ideal for tasks like counting how many orders exceed a certain value, how many employees belong to a department, or how many entries match a specific status.

COUNTIF supports comparison operators and wildcard characters, providing flexibility for both numeric and text-based criteria.

## Syntax
```
=COUNTIF(range, criteria)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| range | Required | The range of cells to evaluate. |
| criteria | Required | The condition that determines which cells to count. Can be a number, expression, text string, or cell reference. |

### Criteria examples
- `100` -- cells equal to 100.
- `">100"` -- cells greater than 100.
- `"Completed"` -- cells containing "Completed".
- `"*report*"` -- cells containing the word "report" anywhere.
- `"<>"` -- non-empty cells.

## Remarks
- Criteria are case-insensitive for text.
- Wildcard characters: use `*` for any sequence of characters, `?` for any single character.
- To count cells matching a literal asterisk or question mark, prefix with a tilde: `"~*"` or `"~?"`.
- COUNTIF works on a single range/criteria pair. For multiple conditions, use COUNTIFS.

## Example

| | A | B |
|---|---|---|
| 1 | **Order ID** | **Status** |
| 2 | 1001 | Shipped |
| 3 | 1002 | Pending |
| 4 | 1003 | Shipped |
| 5 | 1004 | Cancelled |
| 6 | 1005 | Shipped |
| 7 | **Shipped Orders** | =COUNTIF(B2:B6, "Shipped") |

**Result:** 3

The formula counts the number of cells in the Status column that contain "Shipped".

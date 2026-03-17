# XLOOKUP function

## Introduction

The XLOOKUP function searches a range or an array for a match and returns the corresponding item from a second range or array. It is the modern replacement for older lookup functions like VLOOKUP and HLOOKUP, offering greater flexibility and more intuitive syntax.

XLOOKUP is ideal for retrieving data from tables when you know one value (such as a product ID or employee name) and need to find a related value (such as a price or department). Unlike VLOOKUP, XLOOKUP can look in any direction, supports exact and approximate matching, and allows you to specify a custom value when no match is found.

## Syntax

```
=XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for. |
| lookup_array | Required | The range or array to search in. |
| return_array | Required | The range or array from which to return a result. |
| if_not_found | Optional | The value to return if no match is found. If omitted, #N/A is returned when no match exists. |
| match_mode | Optional | Specifies the type of match to perform. Default is 0. |
| search_mode | Optional | Specifies the search mode to use. Default is 1. |

### match_mode values

| Value | Description |
|-------|-------------|
| 0 | Exact match (default). Returns #N/A if no match is found. |
| -1 | Exact match or next smaller item. |
| 1 | Exact match or next larger item. |
| 2 | Wildcard match. Use `*`, `?`, and `~` in lookup_value. |

### search_mode values

| Value | Description |
|-------|-------------|
| 1 | Search first to last (default). |
| -1 | Search last to first (reverse). |
| 2 | Binary search (ascending order). Faster for large sorted datasets. |
| -2 | Binary search (descending order). Faster for large sorted datasets. |

## Remarks

- If lookup_array and return_array have different dimensions, XLOOKUP returns a #VALUE! error.
- Wildcard match (match_mode 2) supports `*` (any sequence of characters), `?` (any single character), and `~` as an escape character for literal `*` or `?`.
- Binary search modes (2 and -2) require that the data is sorted; incorrect results will occur if the data is not sorted in the expected order.

## Example 1 - Exact match (default)

| | A | B | C |
|---|---|---|---|
| 1 | **Product** | **Price** | |
| 2 | Apple | 1.20 | |
| 3 | Banana | 0.50 | |
| 4 | Cherry | 3.00 | |
| 5 | | | |
| 6 | **Lookup** | **Result** | |
| 7 | Banana | =XLOOKUP(A7, A2:A4, B2:B4) | |

**Result:** 0.50

The formula searches for "Banana" in A2:A4 and returns the corresponding price from B2:B4.

## Example 2 - Custom not-found message

| | A | B | C |
|---|---|---|---|
| 1 | **ID** | **Name** | |
| 2 | 101 | Alice | |
| 3 | 102 | Bob | |
| 4 | 103 | Carol | |
| 5 | | | |
| 6 | **Search** | **Result** | |
| 7 | 105 | =XLOOKUP(A7, A2:A4, B2:B4, "Not found") | |

**Result:** "Not found"

Because ID 105 does not exist in the list, the function returns the custom if_not_found text instead of #N/A.

## Example 3 - Approximate match (next smaller)

| | A | B |
|---|---|---|
| 1 | **Score** | **Grade** |
| 2 | 0 | F |
| 3 | 60 | D |
| 4 | 70 | C |
| 5 | 80 | B |
| 6 | 90 | A |
| 7 | | |
| 8 | **Student Score** | **Grade** |
| 9 | 75 | =XLOOKUP(A9, A2:A6, B2:B6, , -1) |

**Result:** C

With match_mode -1, XLOOKUP finds that 75 falls between 70 and 80, so it returns the grade for the next smaller value (70), which is "C".

## Example 4 - Wildcard match

| | A | B |
|---|---|---|
| 1 | **Name** | **Department** |
| 2 | John Smith | Sales |
| 3 | Jane Doe | Marketing |
| 4 | John Adams | Finance |
| 5 | | |
| 6 | **Search** | **Result** |
| 7 | John* | =XLOOKUP(A7, A2:A4, B2:B4, , 2) |

**Result:** Sales

With match_mode 2, the wildcard pattern "John*" matches the first entry starting with "John", returning "Sales".

## Example 5 - Reverse search

| | A | B |
|---|---|---|
| 1 | **Date** | **Status** |
| 2 | 2025-01-01 | Open |
| 3 | 2025-02-15 | In Progress |
| 4 | 2025-03-10 | Open |
| 5 | | |
| 6 | **Search** | **Result** |
| 7 | Open | =XLOOKUP(A7, B2:B4, A2:A4, , 0, -1) |

**Result:** 2025-03-10

With search_mode -1, XLOOKUP searches from last to first and returns the most recent date with "Open" status.

# XLOOKUPS function

## Introduction

The XLOOKUPS function performs a multi-criteria lookup by searching multiple arrays simultaneously and returning the corresponding item from a return array. It extends the concept of XLOOKUP to situations where a single search criterion is not sufficient to uniquely identify a record.

This function is particularly useful when working with datasets that require matching on two or more columns, such as finding a price based on both product name and region, or locating an employee by both department and job title. Without XLOOKUPS, achieving multi-criteria lookups typically requires complex nested formulas or helper columns.

## Syntax

```
=XLOOKUPS(lookup_value1, lookup_array1, [lookup_value2, lookup_array2, ...], return_array, [match_mode], [search_mode])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value1 | Required | The first value to search for. |
| lookup_array1 | Required | The first range or array to search in. |
| lookup_value2 | Optional | The second value to search for. Additional lookup_value/lookup_array pairs can follow. |
| lookup_array2 | Optional | The second range or array to search in. Must be paired with lookup_value2. |
| return_array | Required | The range or array from which to return a result. This is always the last array argument before the optional numeric parameters. |
| match_mode | Optional | Specifies the type of match to perform. Default is 0 (exact match). Same values as XLOOKUP. |
| search_mode | Optional | Specifies the search mode to use. Default is 1 (first to last). Same values as XLOOKUP. |

### match_mode values

| Value | Description |
|-------|-------------|
| 0 | Exact match (default). Returns #N/A if no match is found. |
| -1 | Exact match or next smaller item (applied to the first lookup criterion). |
| 1 | Exact match or next larger item (applied to the first lookup criterion). |
| 2 | Wildcard match. Use `*`, `?`, and `~` in lookup values. |

### search_mode values

| Value | Description |
|-------|-------------|
| 1 | Search first to last (default). |
| -1 | Search last to first (reverse). |
| 2 | Binary search (ascending order). |
| -2 | Binary search (descending order). |

## Remarks

- All lookup arrays and the return array must have the same number of rows (or columns if searching horizontally).
- A match is found only when ALL criteria match on the same row.
- If no match is found across all criteria, XLOOKUPS returns #N/A.
- The match_mode and search_mode apply uniformly to all lookup criteria.

## Example 1 - Two-criteria lookup

| | A | B | C |
|---|---|---|---|
| 1 | **Region** | **Product** | **Price** |
| 2 | East | Widget | 10.00 |
| 3 | East | Gadget | 25.00 |
| 4 | West | Widget | 12.00 |
| 5 | West | Gadget | 23.00 |
| 6 | | | |
| 7 | **Region** | **Product** | **Result** |
| 8 | West | Widget | =XLOOKUPS("West", A2:A5, "Widget", B2:B5, C2:C5) |

**Result:** 12.00

The formula finds the row where region is "West" AND product is "Widget", then returns the corresponding price.

## Example 2 - Three-criteria lookup

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Year** | **Dept** | **Role** | **Salary** |
| 2 | 2024 | Sales | Manager | 85000 |
| 3 | 2024 | Sales | Analyst | 55000 |
| 4 | 2025 | Sales | Manager | 90000 |
| 5 | 2025 | IT | Manager | 95000 |
| 6 | | | | |
| 7 | **Result** | | | |
| 8 | =XLOOKUPS(2025, A2:A5, "Sales", B2:B5, "Manager", C2:C5, D2:D5) | | | |

**Result:** 90000

The formula matches on year (2025), department ("Sales"), and role ("Manager") simultaneously to return the salary.

## Example 3 - Wildcard multi-criteria

| | A | B | C |
|---|---|---|---|
| 1 | **Category** | **Item** | **Stock** |
| 2 | Electronics | Laptop Pro X1 | 45 |
| 3 | Electronics | Tablet Mini 8 | 120 |
| 4 | Furniture | Desk Pro X1 | 30 |
| 5 | | | |
| 6 | **Result** | | |
| 7 | =XLOOKUPS("Electronics", A2:A4, "*Pro*", B2:B4, C2:C4, 2) | | |

**Result:** 45

Using match_mode 2 (wildcard), the formula finds the row where category is "Electronics" and item matches the pattern "*Pro*", returning the stock count for "Laptop Pro X1".

## Example 4 - Reverse search with multiple criteria

| | A | B | C |
|---|---|---|---|
| 1 | **Date** | **Type** | **Amount** |
| 2 | 2025-01-10 | Credit | 500 |
| 3 | 2025-02-15 | Debit | 200 |
| 4 | 2025-03-20 | Credit | 750 |
| 5 | 2025-04-05 | Credit | 300 |
| 6 | | | |
| 7 | **Result** | | |
| 8 | =XLOOKUPS("Credit", B2:B5, C2:C5, 0, -1) | | |

**Result:** 300

With search_mode -1, the function searches from last to first and finds the most recent "Credit" transaction amount. Note: this single-criterion example behaves identically to XLOOKUP with reverse search, but XLOOKUPS can add additional criteria as needed.

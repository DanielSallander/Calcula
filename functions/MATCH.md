# MATCH function

## Introduction

The MATCH function searches for a specified value in a range and returns its relative position within that range. It is most commonly used in combination with INDEX to perform flexible lookups where you need to determine the position of a value before retrieving related data.

Use MATCH when you need to find where a value is located within a list, or when you want to supply a dynamic row or column number to INDEX. MATCH supports exact matching, approximate matching for sorted data, and wildcard matching for partial text searches.

## Syntax

```
=MATCH(lookup_value, lookup_array, [match_type])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for in the lookup_array. |
| lookup_array | Required | A range of cells or an array to search. Must be a single row or single column. |
| match_type | Optional | Specifies the type of match. Default is 1. |

### match_type values

| Value | Description |
|-------|-------------|
| 1 | Finds the largest value less than or equal to lookup_value. The lookup_array must be sorted in ascending order. (Default) |
| 0 | Finds the first value exactly equal to lookup_value. No sorting required. Supports wildcards `*` and `?`. |
| -1 | Finds the smallest value greater than or equal to lookup_value. The lookup_array must be sorted in descending order. |

## Remarks

- MATCH returns the relative position within the array, not the cell address. The first item is position 1.
- If no match is found with match_type 0, MATCH returns a #N/A error.
- MATCH is not case-sensitive when matching text values.
- With match_type 0, you can use `*` (any sequence of characters) and `?` (any single character) as wildcards. Use `~` before a literal `*` or `?`.

## Example

| | A | B |
|---|---|---|
| 1 | **Product** | |
| 2 | Apple | |
| 3 | Banana | |
| 4 | Cherry | |
| 5 | Date | |
| 6 | | |
| 7 | **Lookup** | **Position** |
| 8 | Cherry | =MATCH(A8, A2:A5, 0) |

**Result:** 3

The formula searches for "Cherry" in A2:A5 with an exact match and returns 3, because "Cherry" is the third item in the range.

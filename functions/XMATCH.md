# XMATCH function

## Introduction
The XMATCH function searches for a specified item in a range or array and returns its relative position. It is a modern replacement for MATCH with additional match modes including approximate matching and binary search support.

## Syntax
```
=XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for. |
| lookup_array | Required | The range or array to search in. |
| match_mode | Optional | 0 = exact match (default), -1 = exact or next smaller, 1 = exact or next larger, 2 = wildcard match. |
| search_mode | Optional | 1 = first to last (default), -1 = last to first, 2 = binary search ascending, -2 = binary search descending. |

## Remarks
- Returns a 1-based position number.
- Returns #N/A if no match is found.
- Binary search modes (2, -2) require the data to be sorted; results are unpredictable otherwise.
- Wildcard match mode (2) supports * (any characters) and ? (single character).

## Example

| | A | B |
|---|---|---|
| 1 | **Product** | |
| 2 | Apple | |
| 3 | Banana | |
| 4 | Cherry | |
| 5 | **Position of Banana** | =XMATCH("Banana", A2:A4) |

**Result:** 2

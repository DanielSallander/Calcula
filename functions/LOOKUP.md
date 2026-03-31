# LOOKUP function

## Introduction

The LOOKUP function searches for a value in a one-row or one-column range (the lookup vector) and returns a value from the same position in a second one-row or one-column range (the result vector). LOOKUP uses an approximate match, so the lookup vector must be sorted in ascending order.

## Syntax

```
=LOOKUP(lookup_value, lookup_vector, [result_vector])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for in the lookup vector. |
| lookup_vector | Required | A one-row or one-column range to search. Must be in ascending order. |
| result_vector | Optional | A one-row or one-column range from which to return the result. Must be the same size as lookup_vector. If omitted, lookup_vector is used. |

## Remarks

- LOOKUP always performs an approximate match: it finds the largest value less than or equal to lookup_value.
- The lookup_vector must be sorted in ascending order for correct results.
- If lookup_value is smaller than all values in lookup_vector, #N/A is returned.

## Example

| | A | B |
|---|---|---|
| 1 | 10 | Red |
| 2 | 20 | Blue |
| 3 | 30 | Green |

**Formula:** `=LOOKUP(25, A1:A3, B1:B3)`

**Result:** **"Blue"** - 25 falls between 20 and 30, so the largest value <= 25 is 20, returning the corresponding "Blue".

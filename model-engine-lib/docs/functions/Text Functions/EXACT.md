# EXACT

Compares two text strings and returns TRUE if they are exactly the same, including case. Returns FALSE otherwise.

## Syntax

```
EXACT(text1, text2)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text1` | The first text string to compare. |
| `text2` | The second text string to compare. |

## Return value

A boolean value: TRUE if the two strings are identical (case-sensitive), FALSE otherwise.

## Remarks

- Generates a SQL `(text1 = text2)` expression internally.
- The comparison is case-sensitive. `EXACT("Apple", "apple")` returns FALSE.
- If either argument is NULL, the result is NULL (standard SQL NULL propagation).
- Use EXACT inside an [IF](../Conditional%20Functions/IF.md) expression to branch on string equality.
- For case-insensitive comparison, use [LOWER](LOWER.md) or [UPPER](UPPER.md) on both arguments before comparing.

## Example 1: Check for exact match

Test whether a product color matches a specific value, case-sensitively.

```
DEFINE IsRedExact = IF(EXACT(dim_product[color], "Red"), "Yes", "No")
```

## Example 2: Compare two columns

Check whether the ship-to country matches the bill-to country.

```
DEFINE SameCountry = IF(EXACT(fact_sales[shipcountry], fact_sales[billcountry]), 1, 0)
```

## See also

- [IF](../Conditional%20Functions/IF.md) -- conditional branching
- [LOWER](LOWER.md) -- convert text to lowercase for case-insensitive comparison
- [UPPER](UPPER.md) -- convert text to uppercase
- [FIND](FIND.md) -- case-sensitive search within text
- [SEARCH](SEARCH.md) -- case-insensitive search within text

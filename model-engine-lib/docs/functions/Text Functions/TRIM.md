# TRIM

Removes leading and trailing spaces from a text string.

## Syntax

```
TRIM(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string from which to remove leading and trailing spaces. |

## Return value

A text string with all leading and trailing spaces removed.

## Remarks

- Generates a SQL `TRIM(text)` expression internally.
- Only leading and trailing spaces are removed. Internal spaces are left unchanged.
- Note: DAX TRIM also collapses multiple internal spaces to a single space, but the SQL implementation only trims leading and trailing spaces. If you need to collapse internal spaces, use [SUBSTITUTE](SUBSTITUTE.md) to replace double spaces.
- If `text` is NULL, the result is NULL.

## Example 1: Clean product name

Remove accidental whitespace from product names.

```
DEFINE CleanName = TRIM(dim_product[name])
```

## Example 2: Trim before comparison

Ensure whitespace does not affect an exact comparison.

```
DEFINE IsMatch = IF(EXACT(TRIM(dim_product[color]), "Red"), "Yes", "No")
```

## See also

- [SUBSTITUTE](SUBSTITUTE.md) -- replace text patterns (can be used to collapse internal spaces)
- [LEN](LEN.md) -- return the length of a text string
- [LOWER](LOWER.md) -- convert text to lowercase
- [UPPER](UPPER.md) -- convert text to uppercase
- [EXACT](EXACT.md) -- case-sensitive text comparison

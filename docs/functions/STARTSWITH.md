# STARTSWITH

Returns TRUE if text starts with the given prefix.

## Syntax

```
STARTSWITH(text, prefix)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to examine. |
| `prefix` | The prefix to test for at the beginning of `text`. |

## Return value

A boolean. TRUE if `text` starts with `prefix`, FALSE otherwise.

## Remarks

- Generates SQL `(LEFT(text, LENGTH(prefix)) = prefix)` internally.
- The comparison is case-sensitive. "Road" and "road" are treated as different prefixes.
- Returns FALSE (not an error) when `text` or `prefix` is null.
- For case-insensitive matching, combine with [LOWER](LOWER.md) on both arguments.

## Example 1: Identify product number series

Check whether a product number starts with "BK" (bike series).

```
DEFINE IsBikeSeries = STARTSWITH(dim_product[productnumber], "BK")
```

## Example 2: Categorize by name prefix

Label products whose name begins with "Mountain".

```
DEFINE IsMountainProduct = IF(STARTSWITH(dim_product[name], "Mountain"), "Mountain Line", "Other")
```

## Example 3: Filter by color prefix

Find products with colors starting with "Bl" (Black, Blue, etc.).

```
DEFINE BlColor = STARTSWITH(dim_product[color], "Bl")
```

## See also

- [ENDSWITH](ENDSWITH.md) -- test if text ends with a suffix
- [CONTAINS](CONTAINS.md) -- test if text contains a substring (case-insensitive)
- [LEFT](LEFT.md) -- extract characters from the start of text

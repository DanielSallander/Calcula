# CONTAINS

Returns TRUE if text contains the search substring (case-insensitive).

## Syntax

```
CONTAINS(text, search)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to search within. |
| `search` | The substring to look for. |

## Return value

A boolean. TRUE if `text` contains `search`, FALSE otherwise.

## Remarks

- Generates SQL `(POSITION(LOWER(search) IN LOWER(text)) > 0)` internally.
- The comparison is case-insensitive. Both operands are lowercased before matching.
- Returns FALSE (not an error) when `text` or `search` is null.
- For case-sensitive substring detection, use [FIND](FIND.md) or [SEARCH](SEARCH.md) with a position check instead.

## Example 1: Filter products containing a keyword

Check whether a product name contains the word "mountain".

```
DEFINE IsMountain = CONTAINS(dim_product[name], "mountain")
```

## Example 2: Conditional label based on color

Assign a label when the color description contains "black".

```
DEFINE IsBlackVariant = IF(CONTAINS(dim_product[color], "Black"), "Dark", "Other")
```

## Example 3: Search within category names

Flag categories that mention "bike" anywhere in the name.

```
DEFINE BikeCategory = CONTAINS(dim_product[category], "bike")
```

## See also

- [FIND](FIND.md) -- case-sensitive position search
- [SEARCH](SEARCH.md) -- case-insensitive position search
- [STARTSWITH](STARTSWITH.md) -- test if text begins with a prefix
- [ENDSWITH](ENDSWITH.md) -- test if text ends with a suffix

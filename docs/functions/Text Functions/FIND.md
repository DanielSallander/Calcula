# FIND

Returns the starting position of one text string within another. The search is case-sensitive.

## Syntax

```
FIND(find_text, within_text [, start_pos])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `find_text` | The text string to find. |
| `within_text` | The text string to search within. |
| `start_pos` | Optional. The position from which to start searching, 1-based. Defaults to 1. |

## Return value

An integer representing the 1-based position where `find_text` first appears in `within_text`. Returns 0 if the text is not found.

## Remarks

- Generates a SQL `STRPOS(within_text, find_text)` expression internally.
- The search is case-sensitive. Use [SEARCH](SEARCH.md) for case-insensitive matching.
- Positions are 1-based, consistent with DAX conventions.
- Returns 0 (not an error) when the text is not found, unlike DAX which returns an error.
- The `start_pos` parameter is accepted for DAX compatibility but the SQL implementation always searches from the beginning of the string.

## Example 1: Find a character in a product number

Locate the hyphen in a product number.

```
DEFINE HyphenPos = FIND("-", dim_product[productnumber])
```

## Example 2: Check if text contains a substring

Use FIND with IF to test whether a product name contains a keyword.

```
DEFINE ContainsMountain = IF(FIND("Mountain", dim_product[name]) > 0, "Yes", "No")
```

## See also

- [SEARCH](SEARCH.md) -- case-insensitive version of FIND
- [MID](MID.md) -- extract a substring by position
- [LEFT](LEFT.md) -- extract characters from the start of text
- [SUBSTITUTE](SUBSTITUTE.md) -- replace occurrences of text within a string
- [LEN](LEN.md) -- return the length of a text string

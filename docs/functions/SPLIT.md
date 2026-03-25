# SPLIT

Splits a text string by a delimiter and returns the specified part.

## Syntax

```
SPLIT(text, delimiter, part_number)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to split. |
| `delimiter` | The delimiter string to split on. The entire string is treated as a single delimiter, even if multi-character. |
| `part_number` | The 1-based index of the part to return. Negative values count from the end (-1 = last part). |

## Return value

The specified part of the split text. Returns an empty string if `part_number` is out of range.

## Remarks

- SPLIT is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL as `SPLIT_PART`).
- Part numbering is 1-based: the first part is 1, not 0.
- Negative part numbers count from the end: -1 returns the last part, -2 returns the second-to-last.
- If the delimiter is empty, the entire input string is returned.
- If any argument is NULL, the result is NULL.
- SPLIT generates SQL as `SPLIT_PART(text, delimiter, part_number)`.

## Example 1: Extract domain from email

```
DEFINE Domain = SPLIT(t[email], "@", 2)
```

If `email` is `"user@example.com"`, the result is `"example.com"`.

## Example 2: Extract file extension

```
DEFINE Extension = SPLIT(t[filename], ".", -1)
```

If `filename` is `"report.2024.pdf"`, the result is `"pdf"`.

## Example 3: Extract path component

```
DEFINE SecondFolder = SPLIT(t[path], "/", 3)
```

If `path` is `"/home/user/documents"`, the result is `"user"`.

## See also

- [FIND](FIND.md) — returns the position of text within text
- [MID](MID.md) — returns characters from the middle of a text string
- [LEFT](LEFT.md) — returns characters from the start of a text string
- [SUBSTITUTE](SUBSTITUTE.md) — replaces occurrences of text

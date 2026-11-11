# Google Sheets — notes for Claude

## Rules and limitations

### REST writes
- **Validate with the tools' exported schemas** — `writeSpreadsheetSchema`, `appendSpreadsheetRowsSchema`, `createSpreadsheetSchema`, `clearSpreadsheetRangeSchema`, `batchUpdateSpreadsheetSchema`; never hand-rolled presence checks (they let `values: "a,b"` through). Ops (`performCreateSpreadsheet`, `performBatchUpdateSpreadsheet`) live beside them so webServer holds no second copy.
- **Legacy ChatGPT-compat paths** `POST /api/v1/sheets/{id}/write` and `/append` are unchanged, now catalogued; `openapiOperationId`s match the published spec (`writeRange`, `appendRows`) — a mismatch names an operation nothing answers.
- **Destructive, with sign-off:** `clearSpreadsheetRange` (`/ranges/clear`) and `batchUpdateSpreadsheet` (reaches `deleteSheet`). Operation types are not filtered on REST, to keep one schema.
- **`/api/v1/sheets` is in `REST_LARGE_BODY_PREFIXES`** (5 MB) — the 100 kb default would 413 bulk rows.
- **`createSpreadsheet` answers 201 with `initialDataWritten: false`** if the seed write fails — the file exists; an error would invite a duplicate.
- **`clearSpreadsheetRange` reports the range Google cleared**, which may be wider than requested.
- **Batch per-operation rejection → 400**, matched on `err.name === 'UserError'` (webServer imports no FastMCP).
- **`/write` maps upstream 400 → 400**, not via `sendUpstreamError` (which would say 500).
- Cells accept numbers, booleans and nulls, not only strings.

### Grid size (verified live)
- **A new tab is 1000×26 and `values.update` never grows it** — `writeSpreadsheet` / `POST .../write` past row 1000 fail "exceeds grid limits"; `values.append` (`appendSpreadsheetRows`, `INSERT_ROWS`) does grow it (Google over-allocates). `writeRange` appends which route grows a grid to Google's error, matched on message text.
- **`batchUpdateSpreadsheet` `appendDimension` / `insertDimension`** make room; indices are 1-based inclusive (like `columnWidth`/`rowHeight`), converted to 0-based half-open. `inheritFromBefore` is refused at index 1.
- **Size new tabs with `rowCount`/`columnCount`** (`addSpreadsheetSheet`, `addSheet` op) — metadata is read once before a batch runs, so a tab added in a batch can't be named by a later op in the same batch.
- **Send `gridProperties` only when asked** — `{}` itself resizes. Report the grid Google returned, not the requested one.
- **Deliberately not built:** `pasteData`, and Drive upload (the Drive REST plane is GET-only; a CSV can't be imported without passing through the model).

### Cells, validation, charts (NOT exercised live)
- **`deleteSpreadsheetRowsOrColumns` wraps every failure as "Nothing was deleted: …"** — Google also refuses deleting all non-frozen rows, which the local check cannot see.
- **`deleteSpreadsheetRowsOrColumns` is a tool, not a batch op, and MCP-only** — the batch schema is shared with REST and filters no types, so a batch op would put a destructive delete on the API key. Refuses deleting every row/column (Google does) and re-reads the grid for `confirmed`.
- **`readSpreadsheet` now forwards `valueRenderOption`** — it was accepted and dropped, so `FORMULA` returned displayed values. REST `/read` and `/ranges` take it too.
- **`inspectSpreadsheetCells` lists cells with content only (value, note, link, rule — `hasCellContent`), not formatting-only blanks, capped (`maxCells`)** and says so. REST maps Google's 400 (bad range) to 400. A multi-link cell has no `hyperlink`; links come from `textFormatRuns`.
- **`alignment` masks each property separately** — a whole `userEnteredFormat` mask would wipe number formats and colours.
- **`dataValidation` `dropdownFromRange` is sent as a formula** (`=Sheet!A2:A9`); `clear` sends no rule. `addChart` needs bounded columns (first = categories) and returns `chartIds`.
- **Check first on a live run:** BAR series `targetAxis: BOTTOM_AXIS`, `headerCount: 1` with a numeric first row.

## Source Files

| File | Contains |
|------|----------|
| `src/google-sheets/apiHelpers.ts` | A1 notation parsing, range operations |
| `src/google-sheets/server.ts` | Tool definitions; exported write schemas and ops |

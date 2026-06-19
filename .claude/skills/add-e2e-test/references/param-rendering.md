# Parameter rendering convention

Test prompts mention each required parameter as natural-language `paramName "value"` joined with `and`, matching `e2e/tests/read/readGoogleDoc.smoke.ts` and `e2e/tests/write/appendToGoogleDoc.smoke.ts`. The LLM-driven client picks this up and dispatches the tool call with the right arguments.

| Zod type | Rendering in the prompt |
|---|---|
| `z.string()` | `paramName "value"` |
| `z.number()` | `paramName 42` |
| `z.boolean()` | `paramName true` |
| `z.enum([...])` | `paramName "one-of-the-values"` |
| `z.array(...)` | `paramName [<json array>]` — flag with TODO if non-trivial |
| Nested `z.object(...)` | inline JSON — flag with TODO |

Order the params as they appear in the Zod schema so the prompt reads naturally.

## Choosing literal values

- **ID-shaped strings** (`documentId`, `spreadsheetId`, `fileId`) come from a fixture env var in read mode or the scratch resource in write mode — never hard-code.
- **Mode/format strings** (`format: "text"`, `align: "CENTER"`) — pick a value from the Zod enum; the simplest one is usually fine.
- **Free-form strings** (text to insert, comment body) — use the test's marker so the assertion can verify the round-trip.
- **Indices** (`startIndex`, `endIndex`, `tabId`) — leave as `<TODO: ...>` and flag in the report; these are doc-specific.

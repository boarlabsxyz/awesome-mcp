# Gmail — notes for Claude

## Rules and limitations

### Sending
- **`to`, `subject`, `cc` and `bcc` refuse line breaks in `schemas.ts`** — `createRawEmail` writes them into raw headers, so a CRLF in a piped-in subject could add a hidden `Bcc`.

### Labels
- **`updateLabel` uses `labels.patch`, not `labels.update`** — update is a full replacement and the tool's fields are all optional. Not exercised against live Gmail.

### Trash
- **`deleteEmail` and `batchDeleteEmails` move to Trash; nothing here deletes a message permanently.**
- **`performBatchTrashEmails` reports `trashed`, `failed` and `notAttempted`** — Gmail has no batch trash, so a failure part way leaves some gone. It stops after a batch that fails outright, because the rest would too.

### Reply drafts and filters (NOT exercised live)
- **`draftEmail` `replyToMessageId` reads the parent's `Message-ID`/`References`** and sets `threadId`, `In-Reply-To`, `References` (parent refs + its id) and a non-doubled `Re:` subject; `to` defaults to `Reply-To` then `From`. `threaded` is read from the stored draft. Copied headers have CR/LF stripped.
- **Filters need `gmail.settings.basic`** — added to the catalog seed; connections made before it get a 403 rewritten to "Reconnect Gmail" (`isMissingFilterScope`). The scope must also be on the Google Cloud OAuth consent screen, or consent fails for everyone.
- **No forwarding action** — it needs `gmail.settings.sharing`, which is not requested.
- **`deleteFilter` is MCP-only** (destructive, no REST sign-off) and is the only undo for `createFilter`, which can archive or mark read; the REST catalog note says so.
- **A reply to a message you sent (`SENT` label) goes to its `To`**, not to yourself. Every copied header value is flattened to one line in `replyContext`, and `createRawEmail` flattens `To`/`Subject` too.
- **`hasAttachment: false` is not a criterion** (Gmail has no "without"); a label both added and removed is refused.
- **A filter needs a criterion and an action, refused before any call** (`buildFilter`); Gmail would 400 without naming which.

### REST plane
- **Every write has a REST sibling, with explicit sign-off for the three destructive ones** — the permanent dashboard API key can send mail, trash messages and delete labels.
- **`/messages/send` and `/drafts` keep their old 200 and response keys** — ChatGPT Custom Actions compat routes, now validated with the tool's schema.
- **The PATCH and DELETE on `/messages/{messageId}` stay untouched and uncatalogued** — the catalog takes only GET and POST, so `/modify` and `/trash` are the POST siblings.
- **`batch-modify` reports `confirmed: null`** — Gmail answers 204 with no per-message result, and re-reading up to 1000 messages is not worth it.
- **400, 409 and 429 keep their status** (`gmailPassthroughStatus`) — `sendUpstreamError` would turn them into 500.

## Source Files

| File | Contains |
|------|----------|
| `src/google-gmail/server.ts` | Tool definitions |
| `src/google-gmail/schemas.ts` | Zod schemas for the write tools, shared with the REST routes |
| `src/google-gmail/toolHandlers.ts` | `perform*` ops that throw Gmail's own errors, and the `handle*` tool bodies around them |
| `src/google-gmail/restRoutes.ts` | `GMAIL_WRITE_ROUTES` — the REST write table, one descriptor per endpoint |

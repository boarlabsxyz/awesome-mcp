# Write fixtures — ClickUp

The `clickup` write smoke creates a task through the MCP and cleans up through
the direct ClickUp API (`setup/clickupClient.ts` + `setup/clickupScratch.ts`).

## Workspace requirements

Use a dedicated **test workspace**, or at minimum a dedicated space inside one.
Provision:

| Container | What it is | Env var |
|---|---|---|
| Scratch space | A space that holds only e2e scratch state | `E2E_CLICKUP_SCRATCH_SPACE_ID` |
| Scratch list | A folderless list inside that space — the ClickUp analogue of `e2e-scratch/` | `E2E_CLICKUP_SCRATCH_LIST_ID` |
| Read fixture list | A **separate** list holding the read smoke's fixture task, never mutated | `E2E_FIXTURE_CLICKUP_LIST_ID` (see [read.md](./read.md)) |

> `cleanupScratchList()` deletes every `[e2e]`-prefixed task in
> `E2E_CLICKUP_SCRATCH_LIST_ID`. It is double-scoped — container *and* name
> prefix — so a mistyped id still can't delete anything the harness didn't
> create. Do not point it at a list with real work in it anyway.

The space id is only needed by tests that create their own throwaway list
(`createList` / `deleteList` regressions). The gate's `createTask` smoke needs
only the list id.

## API token

Get a token that can create and delete tasks in the scratch list:

- **Personal token** (simplest): ClickUp → Settings → Apps → Generate (`pk_…`).
- **OAuth access token**: from the same OAuth app the dashboard connector uses.

Either works — `clickupClient.ts` sends `pk_` tokens raw and everything else
with a `Bearer` prefix, matching ClickUp's API.

**It must be the same identity bound to the `awesome-mcp-clickup-full`
connector**, or teardown won't have permission to delete what the MCP created.

## Required GHA secret

| Secret | Source |
|---|---|
| `E2E_CLICKUP_API_TOKEN` | Personal token or OAuth access token for the write workspace |

## Required GHA repo variables

| Variable | Example | Source |
|---|---|---|
| `E2E_CLICKUP_SCRATCH_LIST_ID` | `901234567` | List id from the list URL |
| `E2E_CLICKUP_SCRATCH_SPACE_ID` | `90120001` | Space id from the space URL |

## What the write smoke does

1. Setup builds a `[e2e]`-prefixed task name carrying a `BANANA-CLICKUP-<ms>` marker.
2. The prompt asks the MCP for `createTask` in the scratch list, then `listTasks`.
3. The assertion requires the marker to come back inside the `OUTPUT_BEGIN`/`OUTPUT_END`
   fence — i.e. the task really exists as far as a *read* tool is concerned.
4. Teardown runs `cleanupScratchList()`; the `after()` hook runs it again.

Teardown sweeps by prefix rather than deleting a captured id: the MCP created the
task, so the harness never held its id, and parsing one out of the model's reply
would couple the test to the reply format.

## Health checks

- **Scratch list size**: near zero between runs. If it grows, teardown is broken.
- **Token**: `cleanupScratchList()` throws after 20 passes rather than spinning,
  which is what a token without delete permission looks like.

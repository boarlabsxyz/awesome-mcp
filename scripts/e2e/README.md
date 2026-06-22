# REST data-plane E2E smoke

End-to-end check for the user-story acceptance scenario:

> "Save all calendar events for the week of YYYY-MM-DD to disk, then filter
> into internal vs. external meetings and tell me the count." — in ≤30 s, with
> none of the raw event bytes flowing through the LLM context window.

## How it works

1. From any MCP session, call the `getSecurityToken` MCP tool. It returns a
   5-minute bearer scoped to the calling user.
2. Run `bulk-calendar-fetch.sh <token>`. It parallel-fetches 16 calendar IDs
   via `GET /api/v1/calendars/{id}/events`, saves each response to disk, then
   classifies events as internal vs external with `jq`.
3. The wall-clock budget is hard-checked at 30 s — the script exits non-zero
   if it overruns.

## Quick start

```bash
# Replace the placeholder IDs with real ones from your tenant.
$EDITOR scripts/e2e/calendar-ids.example.txt

# Mint a token in your MCP client (Claude, Inspector, etc.):
#   getSecurityToken()
# Copy the `token` field.

./scripts/e2e/bulk-calendar-fetch.sh "$TOKEN"
```

Output (success):

```text
Fetching events from 2026-06-15T00:00:00Z to 2026-06-21T23:59:59Z across calendars in ...
Output: ./listevents/
Base:   https://awesome-mcp.xyz
Wall-clock: 4s for 16 calendars.
Internal meetings: 23
External meetings: 11
```

## Configuration

| Env var               | Default                       | Purpose                                  |
| --------------------- | ----------------------------- | ---------------------------------------- |
| `AWESOME_MCP_BASE_URL`| `https://awesome-mcp.xyz`     | REST host                                |
| `INTERNAL_DOMAIN`     | `example.com`                 | Email-domain split for internal/external |
| `WEEK_START`          | This week's Monday 00:00 UTC  | ISO 8601 `timeMin`                       |
| `WEEK_END`            | This week's Sunday 23:59 UTC  | ISO 8601 `timeMax`                       |

## CI wiring (not yet automated)

Running this in CI requires a test user with seeded calendars and a valid
OAuth connection. Once those fixtures exist, the workflow is:

```yaml
- name: Mint REST token
  id: token
  run: |
    TOKEN=$(curl -sf -X POST "$AWESOME_MCP_BASE_URL/api/v1/internal/test-mint-token" \
      -H "X-Test-Secret: ${{ secrets.E2E_TEST_SECRET }}" | jq -r .token)
    echo "token=$TOKEN" >> "$GITHUB_OUTPUT"

- name: Bulk-fetch smoke
  run: ./scripts/e2e/bulk-calendar-fetch.sh "${{ steps.token.outputs.token }}"
```

The token-mint endpoint above is not yet implemented; see the task tracker.

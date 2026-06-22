#!/usr/bin/env bash
# Implements the user-story acceptance scenario for the REST data plane:
# "Save all calendar events for a given week to disk, then filter into
# internal vs external meetings and tell me the count" — without any of
# the raw event bytes flowing through the LLM context window.
#
# Inputs:
#   $1                 bearer token (from the getSecurityToken MCP tool)
#   $2 (optional)      calendar-ids file, one ID per line. Defaults to
#                      $REPO_ROOT/scripts/e2e/calendar-ids.example.txt
#                      which contains 16 placeholder IDs.
#   $3 (optional)      output directory. Defaults to ./listevents
#
# Environment:
#   AWESOME_MCP_BASE_URL   defaults to https://awesome-mcp.xyz
#   INTERNAL_DOMAIN        defaults to example.com (used for the jq split)
#   WEEK_START / WEEK_END  ISO timestamps. Defaults to the current week
#                          (Mon 00:00 → Sun 23:59 UTC).
#
# Exits non-zero if any GET fails or if the total wall-clock time exceeds 30s.

set -euo pipefail

TOKEN="${1:-}"
IDS_FILE="${2:-$(dirname "$0")/calendar-ids.example.txt}"
OUTDIR="${3:-./listevents}"

if [[ -z "$TOKEN" ]]; then
  echo "usage: $0 <bearer-token> [calendar-ids.txt] [output-dir]" >&2
  exit 2
fi
if [[ ! -f "$IDS_FILE" ]]; then
  echo "calendar-ids file not found: $IDS_FILE" >&2
  exit 2
fi

BASE_URL="${AWESOME_MCP_BASE_URL:-https://awesome-mcp.xyz}"
INTERNAL_DOMAIN="${INTERNAL_DOMAIN:-example.com}"

# Default week window: today's Monday 00:00Z to following Sunday 23:59:59Z.
if [[ -z "${WEEK_START:-}" || -z "${WEEK_END:-}" ]]; then
  # GNU date and BSD/macOS date have different syntax; try both.
  if date -u -d 'monday -7 days' '+%Y-%m-%d' >/dev/null 2>&1; then
    WEEK_START="$(date -u -d 'monday -7 days' '+%Y-%m-%dT00:00:00Z')"
    WEEK_END="$(date -u -d 'sunday' '+%Y-%m-%dT23:59:59Z')"
  else
    WEEK_START="$(date -u -v-monday '+%Y-%m-%dT00:00:00Z')"
    WEEK_END="$(date -u -v+sunday '+%Y-%m-%dT23:59:59Z')"
  fi
fi

mkdir -p "$OUTDIR"

start_ns=$(date +%s)
echo "Fetching events from ${WEEK_START} to ${WEEK_END} across calendars in $IDS_FILE"
echo "Output: $OUTDIR/"
echo "Base:   $BASE_URL"

fail=0
pids=()
while IFS= read -r cal_id || [[ -n "$cal_id" ]]; do
  [[ -z "$cal_id" || "$cal_id" =~ ^# ]] && continue
  safe_name="$(echo "$cal_id" | tr -c '[:alnum:]_.-' '_')"
  out="$OUTDIR/${safe_name}.json"
  url="${BASE_URL}/api/v1/calendars/$(printf '%s' "$cal_id" | jq -sRr @uri)/events?timeMin=${WEEK_START}&timeMax=${WEEK_END}&maxResults=2500"
  (
    http_code=$(curl --silent --show-error --location --max-time 25 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/json" \
      -o "$out" -w '%{http_code}' "$url")
    if [[ "$http_code" != "200" ]]; then
      echo "FAIL [$cal_id] HTTP $http_code → $out" >&2
      exit 1
    fi
  ) &
  pids+=("$!")
done < "$IDS_FILE"

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then fail=1; fi
done

end_ns=$(date +%s)
elapsed=$((end_ns - start_ns))
echo "Wall-clock: ${elapsed}s for ${#pids[@]} calendars."

if (( fail )); then
  echo "One or more fetches failed; see errors above." >&2
  exit 1
fi
if (( elapsed > 30 )); then
  echo "FAIL: elapsed ${elapsed}s exceeded the 30-second budget." >&2
  exit 1
fi

# Internal vs external classification: an event is "external" if any attendee
# has an email whose domain does not match $INTERNAL_DOMAIN. Everything else
# (and events with no attendees) counts as internal.
internal=0
external=0
for f in "$OUTDIR"/*.json; do
  [[ -f "$f" ]] || continue
  # The endpoint returns {events: [...]}. Each event has an attendees array.
  i=$(jq --arg dom "$INTERNAL_DOMAIN" '
    [ .events[]?
      | select((.attendees // []) | all(.email | test("@"+$dom+"$"; "i")))
    ] | length' "$f")
  e=$(jq --arg dom "$INTERNAL_DOMAIN" '
    [ .events[]?
      | select((.attendees // []) | any(.email | test("@"+$dom+"$"; "i") | not))
    ] | length' "$f")
  internal=$((internal + i))
  external=$((external + e))
done

echo "Internal meetings: $internal"
echo "External meetings: $external"

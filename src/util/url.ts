// Tiny URL utilities. Avoids regex patterns SonarCloud flags for backtracking
// (e.g. `/\/+$/`) by using deterministic string operations.

export function stripTrailingSlashes(s: string): string {
  let out = s;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

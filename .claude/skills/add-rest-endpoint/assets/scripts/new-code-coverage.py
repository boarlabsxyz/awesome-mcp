#!/usr/bin/env python3
"""Report SonarCloud-style new-code coverage for the current branch, locally.

Why this exists: the CI quality gate fails a PR below 80% coverage of NEW code,
counting lines *and* branches, and each CI round trip is ~12 minutes. A per-file
line percentage (from `c8 --reporter=text`) reads as passing while the real
number is several points lower, because it ignores both the branch component and
the fact that only *added* lines count.

Usage:
    # 1. produce an lcov report over the files you touched
    npx c8 --reporter=lcovonly --report-dir=/tmp/cov \
        --include 'src/google-sheets/server.ts' --include 'src/website/webServer.ts' \
        node --import tsx --test src/__tests__/<suites that touch them>.test.ts

    # 2. intersect it with this branch's added lines
    python3 .claude/skills/add-rest-endpoint/assets/scripts/new-code-coverage.py \
        /tmp/cov/lcov.info [--base origin/main] [--] [path ...]

Paths default to every file the branch changed under src/. Pass them explicitly
to match the --include set you gave c8; a file c8 never instrumented is reported
as "not instrumented" rather than silently counted as 0%.
"""
from __future__ import annotations

import argparse
import collections
import os
import re
import subprocess
import sys


def merge_base(base: str) -> str:
    return subprocess.run(['git', 'merge-base', base, 'HEAD'],
                          capture_output=True, text=True, check=True).stdout.strip()


def untracked_files(paths: list[str]) -> list[str]:
    """Non-ignored files git does not know about yet.

    `git diff` cannot see these, so a brand-new module — exactly what this skill
    tells you to create for the op and the schemas — would be left out of both the
    numerator and the denominator, and a well-covered diff could report PASS while
    a whole new file went unmeasured.
    """
    out = subprocess.run(['git', 'ls-files', '--others', '--exclude-standard', '--'] + (paths or ['src']),
                         capture_output=True, text=True, check=True).stdout.split()
    return [f for f in out if f.endswith(('.ts', '.tsx', '.js', '.mjs')) and '__tests__' not in f]


def count_lines(path: str) -> int:
    try:
        with open(path) as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def added_lines(base: str, paths: list[str]) -> dict[str, set[int]]:
    """Post-image line numbers added by this branch, per file.

    Diffs the merge base against the WORKING TREE, not against HEAD: the whole
    point is to check the gate before committing and pushing, and `base...HEAD`
    silently reports nothing for work that is not committed yet. Untracked files
    are added separately, with every line counted as new.
    """
    cmd = ['git', 'diff', '-U0', merge_base(base), '--'] + paths
    diff = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    out: dict[str, set[int]] = collections.defaultdict(set)
    cur, n = None, 0
    for line in diff.splitlines():
        if line.startswith('+++ b/'):
            cur = line[6:].strip()
        elif line.startswith('@@'):
            m = re.search(r'\+(\d+)', line)
            n = int(m.group(1)) if m else 0
        elif line.startswith('+') and not line.startswith('+++') and cur:
            out[cur].add(n)
            n += 1
    return out


def changed_source_files(base: str) -> list[str]:
    cmd = ['git', 'diff', '--name-only', merge_base(base), '--', 'src']
    names = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.split()
    # Test files are not measured by the gate.
    return [n for n in names if n.endswith('.ts') and '__tests__' not in n]


def parse_lcov(path: str) -> tuple[dict, dict]:
    """-> (line hits per file, branch taken-flags per file keyed by line)."""
    cwd = os.getcwd() + os.sep
    lines: dict[str, dict[int, int]] = collections.defaultdict(dict)
    branches: dict[str, dict[int, list[str]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    cur = None
    for raw in open(path):
        raw = raw.strip()
        if raw.startswith('SF:'):
            cur = raw[3:].replace(cwd, '')
        elif raw.startswith('DA:') and cur:
            ln, hits = raw[3:].split(',')[:2]
            lines[cur][int(ln)] = int(hits)
        elif raw.startswith('BRDA:') and cur:
            parts = raw[5:].split(',')
            branches[cur][int(parts[0])].append(parts[3])
    return lines, branches


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('lcov', help='path to lcov.info from c8 --reporter=lcovonly')
    ap.add_argument('--base', default='origin/main')
    ap.add_argument('--gate', type=float, default=80.0)
    ap.add_argument('paths', nargs='*', help='files to measure (default: changed src files)')
    args = ap.parse_args()

    paths = args.paths or changed_source_files(args.base) + untracked_files([])
    if not paths:
        print('No changed source files to measure.')
        return 0
    added = added_lines(args.base, paths)
    # Untracked files carry no diff, so every line of them is new.
    for f in untracked_files(paths):
        added.setdefault(f, set()).update(range(1, count_lines(f) + 1))
    lines, branches = parse_lcov(args.lcov)

    tot_lines = tot_uncov = cov_br = uncov_br = 0
    unmeasured: list[str] = []
    print(f'{"lines":>12}  {"branches":>10}  file')
    for f in sorted(added):
        aset = added[f]
        if f not in lines:
            print(f'{"—":>12}  {"—":>10}  {f}  (NOT INSTRUMENTED — add it to c8 --include)')
            unmeasured.append(f)
            continue
        to_cover = [l for l in aset if l in lines[f]]
        uncovered = [l for l in to_cover if lines[f][l] == 0]
        fbc = fbu = 0
        for ln, flags in branches[f].items():
            if ln in aset:
                for flag in flags:
                    if flag in ('-', '0'):
                        fbu += 1
                    else:
                        fbc += 1
        tot_lines += len(to_cover)
        tot_uncov += len(uncovered)
        cov_br += fbc
        uncov_br += fbu
        br = f'{fbc}/{fbc + fbu}' if fbc + fbu else '—'
        print(f'{len(to_cover) - len(uncovered):>5}/{len(to_cover):<6}  {br:>10}  {f}')
        if uncovered:
            head = ', '.join(str(l) for l in sorted(uncovered)[:10])
            more = '' if len(uncovered) <= 10 else f' … +{len(uncovered) - 10} more'
            print(f'{"":>12}  {"":>10}    uncovered: {head}{more}')

    num = (tot_lines - tot_uncov) + cov_br
    den = tot_lines + cov_br + uncov_br
    if den == 0:
        print('\nNothing measurable.')
        return 0
    pct = 100 * num / den
    print(f'\nnew_coverage = ({tot_lines - tot_uncov} lines + {cov_br} conditions)'
          f' / ({tot_lines} lines + {cov_br + uncov_br} conditions) = {pct:.1f}%')
    if unmeasured:
        # Never report a clean PASS over a partial scope: a well-covered file would
        # mask a changed one with no coverage data at all, and CI measures both.
        print(f'gate = {args.gate:.0f}%  →  INCOMPLETE — {len(unmeasured)} changed file(s) have no coverage data:')
        for f in unmeasured:
            print(f'  {f}')
        print('Re-run with those files in --include, or with tests that import them. '
              'CI counts them as uncovered, so this number is optimistic.')
        return 2
    print(f'gate = {args.gate:.0f}%  →  {"PASS" if pct >= args.gate else "FAIL"}')
    # A local subset can read slightly high: the suites you ran are a subset of
    # CI's, but CI also measures every added line, including files you did not
    # pass here. Treat a result within ~2 points of the gate as unproven.
    if pct >= args.gate and pct - args.gate < 2:
        print('margin under 2 points — thin enough that CI may still fail; cover more before pushing')
    return 0 if pct >= args.gate else 1


if __name__ == '__main__':
    sys.exit(main())

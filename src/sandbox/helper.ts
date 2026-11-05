// A small Python module written into every new sandbox as
// /home/user/awesome.py, so a script can call this platform's REST plane in one
// line: `from awesome import api; api('GET', '/api/v1/storage/collections')`.
// It reads the per-run bearer from the environment at call time — the token is
// minted for each run and revoked when the run ends (ops.ts).

export const HELPER_PATH = '/home/user/awesome.py';

export const HELPER_SOURCE = `"""Call the Awesome MCP REST API (/api/v1/...) as the signed-in user.

AWESOME_API_BASE and AWESOME_API_TOKEN are set for each runCode call; the
token is valid only while that run lasts.
"""
import json
import os
import urllib.error
import urllib.request


def api(method, path, body=None, timeout=120):
    """Send one request and return the parsed JSON (or the text).

    api('GET', '/api/v1/storage/collections')
    api('POST', '/api/v1/storage/collections/people/find', {'limit': 100})
    Raises RuntimeError with the status and the error body on a non-2xx answer.
    """
    base = os.environ.get('AWESOME_API_BASE')
    token = os.environ.get('AWESOME_API_TOKEN')
    if not base or not token:
        raise RuntimeError('AWESOME_API_BASE / AWESOME_API_TOKEN are not set: call api() from code run by runCode.')
    url = base.rstrip('/') + (path if path.startswith('/') else '/' + path)
    data = None if body is None else json.dumps(body).encode('utf-8')
    request = urllib.request.Request(url, data=data, method=method.upper(), headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode('utf-8')
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:2000]
        raise RuntimeError(f'{method.upper()} {path} -> {error.code}: {detail}') from None
    try:
        return json.loads(raw)
    except ValueError:
        return raw
`;

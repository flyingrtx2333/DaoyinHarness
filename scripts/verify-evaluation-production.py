"""Read-only deployed acceptance; never signs in, creates users or calls a model."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

ORIGIN = 'https://www.daoyintech.com'
ROOT = pathlib.Path('/opt/daoyin-harness')


def fetch(url, body=None, headers=None):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                    headers={'Accept': 'application/json', **(headers or {}),
                                             **({'Content-Type': 'application/json'} if body is not None else {})})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read(2_000_001)
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', required=True)
    parser.add_argument('--backend-revision', required=True)
    args = parser.parse_args()
    if not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.revision, args.backend_revision)):
        raise RuntimeError('Full revisions required')
    report = {'revision': args.revision, 'backendRevision': args.backend_revision, 'checks': [],
              'authenticatedSuperadminBrowser': 'not-performed', 'realModelCalls': 0}
    def check(name, passed):
        report['checks'].append({'name': name, 'passed': bool(passed)})
        if not passed:
            raise RuntimeError('Failed: ' + name)
    for component, link in [('runtime', ROOT / 'current'), ('workbench', ROOT / 'workbench/current'),
                            ('evaluation', pathlib.Path('/opt/daoyin-harness-evaluation/current'))]:
        manifest = json.loads((link / 'release.json').read_text(encoding='utf-8-sig'))
        check(component + '-revision', manifest.get('revision') == args.revision)
    image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'daoyintech-backend'], text=True).strip()
    check('backend-image', image.endswith(':' + args.backend_revision))
    for name, url, expected in [('runtime-ready', 'http://127.0.0.1:4700/health/ready', 'ready'),
                                 ('evaluation-ready', 'http://127.0.0.1:4711/health', 'ok')]:
        status, data = fetch(url)
        check(name, status == 200 and json.loads(data).get('status') == expected)
    status, html = fetch(ORIGIN + '/harness/')
    check('workbench-http', status == 200)
    local = ROOT / 'workbench/current'
    manifest = json.loads((local / 'release.json').read_text(encoding='utf-8-sig'))
    check('served-index-hash', hashlib.sha256(html).hexdigest() == manifest['files']['index.html'])
    for name, digest in manifest['files'].items():
        if name.endswith(('.js', '.css')):
            status, data = fetch(ORIGIN + '/harness/' + name)
            check('served-asset-' + name, status == 200 and hashlib.sha256(data).hexdigest() == digest)
    checks = [
        ('anonymous-bootstrap-denied', ORIGIN + '/api/harness-evaluation/bootstrap', {}, {'Origin': ORIGIN}, 401),
        ('anonymous-catalog-denied', ORIGIN + '/api/harness-evaluation/catalog', None, {}, 401),
        ('anonymous-report-denied', ORIGIN + '/api/harness-evaluation/runs/ev_' + '0' * 32 + '/report', None, {}, 401),
        ('direct-runner-denied', ORIGIN + '/api/internal/harness-evaluation-runner/catalog', None, {}, 401),
    ]
    for name, url, body, headers, expected in checks:
        status, _ = fetch(url, body, headers)
        check(name, status == expected)
    # A service credential alone cannot impersonate an administrator. The session
    # identifier is intentionally nonexistent; no account is created or changed.
    values = {}
    for line in pathlib.Path('/etc/daoyin-harness-evaluation/environment').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep:
            values[key] = value.strip().strip('"').strip("'")
    status, _ = fetch('http://127.0.0.1:4711/catalog', headers={
        'x-eval-service-token': values['DAOYIN_EVAL_SERVICE_TOKEN'],
        'x-eval-actor': '999999', 'x-eval-session': '0' * 48})
    check('service-token-without-valid-admin-denied', status == 403)
    report['liveModelConfigured'] = bool(values.get('DAOYIN_EVAL_MODEL_KEY'))
    report['status'] = 'passed-read-only-deployed-checks'
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        sys.exit(1)

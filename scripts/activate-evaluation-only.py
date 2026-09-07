"""Explicit independent evaluator rollout; never restarts chat or migrates business data."""
import argparse
import json
import os
import pathlib
import re
import runpy
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
helpers = runpy.run_path(str(ROOT / 'scripts/deploy-evaluation-release.py'))
command, environment, verify_files = (helpers[name] for name in ('command', 'environment', 'verify_files'))
EVAL = pathlib.Path('/opt/daoyin-harness-evaluation')
ENV = pathlib.Path('/etc/daoyin-harness-evaluation/environment')
UNIT = pathlib.Path('/etc/systemd/system/daoyin-harness-evaluation.service')
ROUTE = pathlib.Path('/www/server/panel/vhost/nginx/extension/www.daoyintech.com/harness-evaluation.conf')
NGINX = '/www/server/nginx/sbin/nginx'
SERVICE = 'daoyin-harness-evaluation.service'


def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', required=True, help='Full committed revision already installed in runtime releases')
    args = parser.parse_args()
    revision = args.apply
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{40}', revision):
        raise RuntimeError('Explicit root deployment and full revision required')
    target = pathlib.Path('/opt/daoyin-harness/releases') / revision
    verify_files(target, revision)
    if not (target / 'evaluation.mjs').is_file():
        raise RuntimeError('Evaluation artifact missing')
    values = environment(ENV)
    if values.get('DAOYIN_EVAL_DB') != '/var/lib/daoyin-harness-evaluation/evaluation.sqlite' or values.get('DAOYIN_EVAL_PORT') != '4711':
        raise RuntimeError('Expected independent evaluation database and port')
    backend = json.loads(command(['docker', 'inspect', 'daoyintech-backend']))[0]
    configured = dict(item.split('=', 1) for item in backend['Config']['Env'] if '=' in item)
    if not values.get('DAOYIN_EVAL_SERVICE_TOKEN') or values['DAOYIN_EVAL_SERVICE_TOKEN'] != configured.get('HARNESS_EVALUATION_SERVICE_TOKEN'):
        raise RuntimeError('Evaluation service identity differs from main platform')
    if configured.get('HARNESS_EVALUATION_SERVICE_URL', '').rstrip('/') != 'https://www.daoyintech.com/api/internal/harness-evaluation-runner':
        raise RuntimeError('Main platform is not configured for the approved runner route')
    hosts = helpers['hosts']()
    if len(hosts) != 1:
        raise RuntimeError('Expected exactly one website vhost')
    vhost = pathlib.Path(hosts[0]).read_text()
    if 'include /www/server/panel/vhost/nginx/extension/www.daoyintech.com/*.conf;' not in vhost:
        raise RuntimeError('Approved extension directory is not included')
    if 'location ^~ /api/internal/harness-evaluation-runner/' in vhost:
        raise RuntimeError('Existing inline runner route requires review; not adding a duplicate')
    database = pathlib.Path(values['DAOYIN_EVAL_DB'])
    if database.exists():
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'evaluation_runs' in tables and connection.execute("SELECT count(*) FROM evaluation_runs WHERE status IN ('running','cancelling')").fetchone()[0]:
                raise RuntimeError('An evaluation is active; no service changes made')
    backup = helpers['backup']()
    previous = {'unit': UNIT.exists(), 'route': ROUTE.exists(), 'link': os.readlink(EVAL / 'current') if (EVAL / 'current').is_symlink() else None,
                'active': subprocess.run(['systemctl', 'is-active', '--quiet', SERVICE]).returncode == 0}
    for label, path in [('unit', UNIT), ('route', ROUTE)]:
        if previous[label]: shutil.copyfile(path, backup / (label + '.before'))
    (backup / 'evaluation-only-before.json').write_text(json.dumps(previous))
    try:
        if subprocess.run(['id', '-u', 'daoyin-eval'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            command(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'daoyin-eval'])
        EVAL.mkdir(parents=True, exist_ok=True, mode=0o755)
        if (EVAL / 'current').exists() and not (EVAL / 'current').is_symlink():
            raise RuntimeError('Refusing to replace a non-symlink evaluation directory')
        service = (ROOT / 'deployment/daoyin-harness-evaluation.service.example').read_text().replace('/usr/bin/node ', '/opt/daoyin-harness/node/bin/node ')
        UNIT.write_text(service); UNIT.chmod(0o644)
        ROUTE.parent.mkdir(parents=True, exist_ok=True)
        ROUTE.write_text((ROOT / 'deployment/nginx-evaluation.conf.example').read_text().split('# Browser ')[0]); ROUTE.chmod(0o644)
        command([NGINX, '-t'])
        helpers['switch'](EVAL / 'current', target)
        command(['systemctl', 'daemon-reload'])
        command(['systemctl', 'enable', SERVICE])
        command(['systemctl', 'restart', SERVICE])
        healthy = False
        for _ in range(20):
            try:
                status, body = http_status('http://127.0.0.1:4711/health')
                healthy = status == 200 and body.get('execution') == 'platform-runtime-only'
            except Exception: healthy = False
            if healthy: break
            time.sleep(1)
        if not healthy: raise RuntimeError('New evaluation service did not become healthy')
        command([NGINX, '-s', 'reload'])
        status = 0
        for _ in range(12):
            # Nginx reload is graceful: old workers may briefly serve the former route.
            try: status, _ = http_status('https://www.daoyintech.com/api/internal/harness-evaluation-runner/catalog')
            except Exception: status = 0
            if status == 401: break
            time.sleep(1)
        if status != 401: raise RuntimeError(f'Runner ingress did not enforce service authentication (HTTP {status})')
        print(json.dumps({'deployed': True, 'revision': revision, 'evaluationHealth': 200, 'anonymousRunner': status,
                          'chatRestarted': False, 'businessDataMigrated': False, 'backup': str(backup)}))
    except Exception:
        subprocess.run(['systemctl', 'stop', SERVICE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for label, path in [('unit', UNIT), ('route', ROUTE)]:
            if previous[label]: shutil.copyfile(backup / (label + '.before'), path)
            else: path.unlink(missing_ok=True)
        if previous['link']: helpers['switch'](EVAL / 'current', pathlib.Path(previous['link']))
        elif (EVAL / 'current').is_symlink(): (EVAL / 'current').unlink()
        if not previous['unit']: subprocess.run(['systemctl', 'disable', SERVICE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        command(['systemctl', 'daemon-reload']); command([NGINX, '-t']); command([NGINX, '-s', 'reload'])
        if previous['active']: command(['systemctl', 'start', SERVICE])
        raise


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'deployed': False, 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        raise SystemExit(1)

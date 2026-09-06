"""Explicit server-side evaluation rollout. No credentials are printed or accepted in arguments.

Run as root on the existing Daoyin host after Windows/Docker CI validation.
probe is read-only; configure backs up and patches only the evaluation configuration;
install verifies a downloaded release manifest; activate changes pinned symlinks.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path('/opt/daoyin-harness')
EVAL = pathlib.Path('/opt/daoyin-harness-evaluation')
ENV = pathlib.Path('/etc/daoyin-harness-evaluation/environment')
MAIN_ENV = pathlib.Path('/www/wwwroot/daoyintech/backend/.env')
VHOSTS = pathlib.Path('/www/server/panel/vhost/nginx')
NGINX = '/www/server/nginx/sbin/nginx'
NODE = str(ROOT / 'node/bin/node')
ORIGIN = 'https://www.daoyintech.com'


def command(args, timeout=60, env=None):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, env=env)
    if result.returncode:
        raise RuntimeError('Command failed: ' + args[0])
    return result.stdout.strip()


def environment(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
                values[key] = value.strip().strip('"').strip("'")
    return values


def eval_model():
    try:
        data = json.loads(command(['docker', 'inspect', 'daoyintech-builder-evaluation']))[0]
        values = dict(item.split('=', 1) for item in data['Config']['Env'] if '=' in item)
    except Exception:
        return {}
    if not all(values.get(k) for k in ('BUILDER_EVAL_ENDPOINT', 'BUILDER_EVAL_API_KEY', 'BUILDER_EVAL_MODEL')):
        return {}
    endpoint = values['BUILDER_EVAL_ENDPOINT'].rstrip('/')
    if not endpoint.startswith('https://'):
        return {}
    if not endpoint.endswith('/chat/completions'):
        endpoint += '/chat/completions'
    return {'DAOYIN_EVAL_MODEL_ENDPOINT': endpoint,
            'DAOYIN_EVAL_MODEL_KEY': values['BUILDER_EVAL_API_KEY'],
            'DAOYIN_EVAL_MODEL': values['BUILDER_EVAL_MODEL']}


def hosts():
    result = []
    for path in VHOSTS.glob('*.conf'):
        text = path.read_text()
        if re.search(r'server_name\s+[^;]*\bwww\.daoyintech\.com\b[^;]*;', text):
            result.append(str(path))
    return result


def backup():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path = pathlib.Path('/var/backups/daoyin-agent') / ('evaluation-' + stamp)
    path.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, source in [('platform.env', MAIN_ENV), ('evaluation.env', ENV)]:
        if source.exists():
            shutil.copyfile(source, path / name)
            (path / name).chmod(0o600)
    state = {}
    for name, link in [('runtime', ROOT / 'current'), ('workbench', ROOT / 'workbench/current'), ('evaluation', EVAL / 'current')]:
        state[name] = str(link.resolve()) if link.exists() else None
    state['backendImage'] = command(['docker', 'inspect', '--format', '{{.Config.Image}}', 'daoyintech-backend'])
    (path / 'before.json').write_text(json.dumps(state, indent=2))
    for host in hosts():
        shutil.copyfile(host, path / pathlib.Path(host).name)
    print(json.dumps({'backupDirectory': str(path)}))
    return path


def patch_environment(path, updates):
    text = path.read_text() if path.exists() else ''
    for key, value in updates.items():
        if '\n' in value or '\r' in value or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise RuntimeError('Invalid environment value')
        line = key + '=' + value
        if re.search(r'^' + re.escape(key) + r'=.*$', text, re.M):
            text = re.sub(r'^' + re.escape(key) + r'=.*$', lambda _: line, text, flags=re.M)
        else:
            text = text.rstrip('\n') + '\n' + line + '\n'
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.evaluation-new')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        stream.write(text)
    os.replace(temporary, path)


def configure():
    if not MAIN_ENV.exists():
        raise RuntimeError('Existing platform environment not found')
    backup()
    current = environment(ENV)
    key = current.get('DAOYIN_EVAL_SERVICE_TOKEN') or secrets.token_urlsafe(48)
    patch_environment(ENV, {'DAOYIN_EVAL_DB': '/var/lib/daoyin-harness-evaluation/evaluation.sqlite',
                           'DAOYIN_EVAL_SERVICE_TOKEN': key, 'DAOYIN_EVAL_PLATFORM_URL': ORIGIN,
                           'DAOYIN_EVAL_PORT': '4711'})
    # Reuse only the dedicated evaluation model, never a business provider or service key.
    model = eval_model()
    if model and not current.get('DAOYIN_EVAL_MODEL_KEY'):
        patch_environment(ENV, model)
    patch_environment(MAIN_ENV, {'HARNESS_EVALUATION_SERVICE_URL': ORIGIN + '/api/internal/harness-evaluation-runner',
                                'HARNESS_EVALUATION_SERVICE_TOKEN': key, 'HARNESS_EVALUATION_ORIGIN': ORIGIN})
    print(json.dumps({'evaluationConfigured': True, 'dedicatedModelConfigured': bool(environment(ENV).get('DAOYIN_EVAL_MODEL_KEY'))}))


def verify_files(directory, revision):
    manifest = json.loads((directory / 'release.json').read_text(encoding='utf-8-sig'))
    if manifest.get('revision') != revision or manifest.get('preview'):
        raise RuntimeError('Artifact is not the requested committed release')
    for name, expected in manifest['files'].items():
        path = directory / name
        if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts or path.is_symlink():
            raise RuntimeError('Unsafe artifact path')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Artifact checksum mismatch: ' + name)
    return manifest


def install(bundle, revision):
    validation = json.loads((bundle / 'validation.json').read_text(encoding='utf-8-sig'))
    if validation.get('revision') != revision or validation.get('validation') != 'windows-2025':
        raise RuntimeError('Validated Windows release receipt is required')
    for kind in ('runtime', 'workbench'):
        verify_files(bundle / kind, revision)
    target = ROOT / 'releases' / revision
    web = ROOT / 'workbench/releases' / revision
    for source, dest in [(bundle / 'runtime', target), (bundle / 'workbench', web)]:
        if dest.exists():
            verify_files(dest, revision)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, dest)
    env = {**os.environ, 'PATH': str(ROOT / 'node/bin') + os.pathsep + os.environ['PATH']}
    command([str(ROOT / 'node/bin/npm'), 'ci', '--prefix', str(target), '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], timeout=180, env=env)
    verify_files(target, revision)
    print(json.dumps({'installedRevision': revision, 'activated': False}))


def switch(link, target):
    link.parent.mkdir(parents=True, exist_ok=True)
    temporary = link.with_name(link.name + '.evaluation-new')
    if temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, link)


def activate(revision, templates):
    target = ROOT / 'releases' / revision
    web = ROOT / 'workbench/releases' / revision
    verify_files(target, revision); verify_files(web, revision)
    if not ENV.exists():
        raise RuntimeError('Configure the independent environment first')
    active = command(['runuser', '-u', 'postgres', '--', 'psql', '-d', 'daoyinharness', '-Atc', "SELECT count(*) FROM cloud_runs WHERE status='running'"])
    if active != '0':
        raise RuntimeError('Active Agent runs exist; leave them untouched and retry later')
    saved = backup()
    try:
        command(['id', '-u', 'daoyin-eval'])
    except RuntimeError:
        command(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'daoyin-eval'])
    service = (templates / 'daoyin-harness-evaluation.service.example').read_text()
    service = service.replace('/usr/bin/node ', NODE + ' ')
    pathlib.Path('/etc/systemd/system/daoyin-harness-evaluation.service').write_text(service)
    candidates = hosts()
    if len(candidates) != 1:
        raise RuntimeError('Expected one exact active website vhost; review before changing routing')
    host = pathlib.Path(candidates[0]); original = host.read_text()
    route = (templates / 'nginx-evaluation.conf.example').read_text().split('# Browser ')[0]
    if 'location ^~ /api/internal/harness-evaluation-runner/' not in original:
        # Place only inside the first HTTPS website server; existing routes remain untouched.
        match = re.search(r'server\s*\{', original)
        if not match:
            raise RuntimeError('Website server block missing')
        host.write_text(original[:match.end()] + '\n' + route + '\n' + original[match.end():])
    try:
        command([NGINX, '-t'])
    except Exception:
        host.write_text(original)
        raise
    before = json.loads((saved / 'before.json').read_text())
    try:
        command(['systemctl', 'stop', 'daoyin-harness-cloud'])
        switch(ROOT / 'current', target); switch(ROOT / 'workbench/current', web); switch(EVAL / 'current', target)
        command(['systemctl', 'daemon-reload'])
        command(['systemctl', 'start', 'daoyin-harness-cloud'])
        command(['systemctl', 'enable', '--now', 'daoyin-harness-evaluation'])
        command([NGINX, '-s', 'reload'])
        for endpoint in ['http://127.0.0.1:4700/health/ready', 'http://127.0.0.1:4711/health']:
            healthy = False
            for _ in range(20):
                try:
                    with urllib.request.urlopen(endpoint, timeout=6) as response:
                        body = json.load(response)
                    healthy = body.get('status') in ('ready', 'ok')
                except Exception:
                    healthy = False
                if healthy:
                    break
                time.sleep(1)
            if not healthy:
                raise RuntimeError('Candidate readiness failed; restoring previous artifact pointers')
    except Exception:
        command(['systemctl', 'stop', 'daoyin-harness-cloud'])
        command(['systemctl', 'stop', 'daoyin-harness-evaluation'])
        for name, link in [('runtime', ROOT / 'current'), ('workbench', ROOT / 'workbench/current'), ('evaluation', EVAL / 'current')]:
            if before[name]:
                switch(link, pathlib.Path(before[name]))
        host.write_text(original)
        command([NGINX, '-t']); command([NGINX, '-s', 'reload'])
        command(['systemctl', 'start', 'daoyin-harness-cloud'])
        if before['evaluation']:
            command(['systemctl', 'start', 'daoyin-harness-evaluation'])
        raise
    print(json.dumps({'activatedRevision': revision, 'readiness': 'passed', 'rollbackMetadata': str(saved / 'before.json')}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['probe', 'configure', 'install', 'activate'])
    parser.add_argument('--revision')
    parser.add_argument('--bundle', type=pathlib.Path)
    parser.add_argument('--templates', type=pathlib.Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Run on the authorized deployment host as root')
    if args.action == 'probe':
        print(json.dumps({'node': command([NODE, '--version']), 'vhosts': hosts(),
                          'runtime': str((ROOT / 'current').resolve()),
                          'workbench': str((ROOT / 'workbench/current').resolve()),
                          'dedicatedEvaluationModelAvailable': bool(eval_model()),
                          'evaluationAlreadyConfigured': ENV.exists()}))
    elif args.action == 'configure':
        configure()
    else:
        if not args.revision or not re.fullmatch(r'[a-f0-9]{40}', args.revision):
            raise RuntimeError('Full revision required')
        if args.action == 'install':
            install(args.bundle.resolve(strict=True), args.revision)
        else:
            activate(args.revision, args.templates.resolve(strict=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print tracebacks containing subprocess output or protected env values.
        print(json.dumps({'status': 'failed', 'stageError': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)

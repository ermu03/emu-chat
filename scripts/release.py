#!/usr/bin/python3
"""Local emu-chat release management; no model calls or Git mutations."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

BASE = Path('/home/emu/.emu-chat')
DEV = Path('/home/emu/projects/emu-chat')
RELEASES = BASE / 'releases'
NODE = '/usr/bin/node'
NPM = '/usr/bin/npm'
ENV = {**os.environ, 'PATH': '/usr/bin:/bin'}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def run(*args, cwd=None, capture=False):
    print('+', ' '.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), cwd=cwd, env=ENV, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None)


def output(*args, cwd=None):
    return run(*args, cwd=cwd, capture=True).stdout.strip()


def runtime():
    version = output(NODE, '--version')
    if not version.startswith('v24.'):
        raise RuntimeError('System /usr/bin/node must be Node.js 24 LTS')
    return version


def release_path(version):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', version):
        raise RuntimeError('Invalid release name')
    path = RELEASES / version
    if path.is_symlink():
        raise RuntimeError('Release directory must not be a symlink')
    return path


@contextlib.contextmanager
def locked():
    BASE.mkdir(mode=0o700, exist_ok=True)
    with (BASE / '.release.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def atomic_text(path, text):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    temporary.replace(path)


def point(target):
    temporary = BASE / '.current.next'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(BASE / 'current')


def info(path):
    result = {}
    file = path / 'RELEASE_INFO'
    if file.exists():
        for line in file.read_text().splitlines():
            if ': ' in line:
                key, value = line.split(': ', 1)
                result[key] = value
    return result


def write_info(path, values):
    atomic_text(path / 'RELEASE_INFO', ''.join(f'{k}: {v}\n' for k, v in values.items()))


def validate(path):
    runtime()
    for name in ('RELEASE_INFO', 'dist/server/index.js', 'dist/client/index.html',
                 'package-lock.json', 'migrations/0001_initial.sql'):
        if not (path / name).is_file():
            raise RuntimeError(f'Incomplete release: {path / name}')
    if (path / '.env').exists() or (path / 'data').exists():
        raise RuntimeError('Release contains local .env or data; rebuild it')
    metadata = info(path)
    if metadata.get('status') == 'building':
        raise RuntimeError('Release build is incomplete')
    abi = output(NODE, '-p', 'process.versions.modules')
    if metadata.get('node_abi') != abi:
        raise RuntimeError('Native dependency ABI differs; rebuild this release')
    run(NODE, '-e', "const D=require('better-sqlite3'); const d=new D(':memory:'); "
        "d.prepare('select 1').get(); d.close();", cwd=path)


def build(version, ref):
    node_version = runtime()
    target = release_path(version)
    if target.exists():
        raise RuntimeError(f'Release already exists: {target}')
    if ref is None:
        if output('git', 'status', '--porcelain', cwd=DEV):
            raise RuntimeError('Working tree is dirty; commit first or specify an explicit Git ref')
        ref = 'HEAD'
    commit = output('git', 'rev-parse', '--verify', f'{ref}^{{commit}}', cwd=DEV)
    if len(commit) != 40:
        raise RuntimeError('Cannot resolve source commit')
    RELEASES.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.build-', dir=RELEASES) as temporary:
        staging = Path(temporary)
        archive = staging / 'source.tar'
        run('git', 'archive', '--format=tar', f'--output={archive}', commit, cwd=DEV)
        run('tar', '-xf', archive, '-C', staging)
        archive.unlink()
        if (staging / '.env').exists() or (staging / 'data').exists():
            raise RuntimeError('Source commit contains environment or data files')
        run(NPM, 'ci', '--include=dev', '--prefer-offline', '--no-audit', '--no-fund', cwd=staging)
        run(NPM, 'run', 'build', cwd=staging)
        run(NPM, 'prune', '--omit=dev', '--no-audit', '--no-fund', cwd=staging)
        write_info(staging, {'version': version, 'commit': commit, 'short_commit': commit[:7],
                            'built_at': now(), 'node_version': node_version,
                            'npm_version': output(NPM, '--version'),
                            'node_abi': output(NODE, '-p', 'process.versions.modules'),
                            'lock_sha256': hashlib.sha256((staging / 'package-lock.json').read_bytes()).hexdigest(),
                            'status': 'staged'})
        validate(staging)
        staging.rename(target)
    print(f'Built {version} from {commit}; current service unchanged', flush=True)


def read_env():
    values = {}
    for line in (BASE / '.env').read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"\'')
    if Path(values.get('EMU_CHAT_DATA_DIR', '')).resolve() != BASE / 'data':
        raise RuntimeError('Production EMU_CHAT_DATA_DIR must be the absolute deployment data path')
    return values


def backup_db(source, target):
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as db:
        with contextlib.closing(sqlite3.connect(target)) as destination:
            db.backup(destination)
            if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError(f'Backup integrity check failed: {source}')


def backup():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = BASE / 'backups' / stamp
    target.mkdir(mode=0o700, parents=True)
    shutil.copy2(BASE / '.env', target / '.env')
    for source in (BASE / 'data').iterdir():
        if source.name.endswith(('-wal', '-shm')):
            continue
        if source.suffix in ('.sqlite', '.db'):
            backup_db(source, target / 'data' / source.name)
        elif source.is_dir():
            shutil.copytree(source, target / 'data' / source.name)
        else:
            (target / 'data').mkdir(mode=0o700, exist_ok=True)
            shutil.copy2(source, target / 'data' / source.name)
    # Hermes remains online. These online SQLite snapshots are individually
    # consistent; they do not promise an atomic snapshot across services.
    hermes = Path('/home/emu/.hermes')
    for name in ('state.db', 'response_store.db', 'runs_idempotency.db'):
        if (hermes / name).exists():
            backup_db(hermes / name, target / 'hermes' / name)
    for name in ('.env', 'config.yaml'):
        if (hermes / name).exists():
            (target / 'hermes').mkdir(mode=0o700, exist_ok=True)
            shutil.copy2(hermes / name, target / 'hermes' / name)
    media = hermes / 'emu-media'
    if (media / 'media.sqlite').exists():
        backup_db(media / 'media.sqlite', target / 'hermes/emu-media/media.sqlite')
        if (media / 'files').exists():
            shutil.copytree(media / 'files', target / 'hermes/emu-media/files')
    (target / 'BACKUP_INFO').write_text(json.dumps({'created_at': now(),
        'current': str((BASE / 'current').resolve()),
        'scope': 'emu-chat stopped; Hermes online; each SQLite snapshot consistent'}, indent=2) + '\n')
    print(f'Backup: {target}', flush=True)
    return target


def migration_versions(path):
    return {int(p.name.split('_', 1)[0]) for p in (path / 'migrations').glob('*.sql')
            if re.match(r'^\d+_', p.name)}


def compatible(path):
    dbfile = BASE / 'data/emu-chat.sqlite'
    if not dbfile.exists():
        return True
    with contextlib.closing(sqlite3.connect(dbfile.as_uri() + '?mode=ro', uri=True)) as db:
        applied = {row[0] for row in db.execute('SELECT version FROM schema_migrations')}
    return applied <= migration_versions(path)


def healthy(path, config):
    port = int(config.get('EMU_CHAT_PORT', '3000'))
    for _ in range(30):
        try:
            pid = output('systemctl', '--user', 'show', 'emu-chat.service', '-p', 'MainPID', '--value')
            if pid == '0' or Path(f'/proc/{pid}/cwd').resolve() != path:
                raise RuntimeError('Service has not started the target release')
            if Path(f'/proc/{pid}/exe').resolve() != Path(NODE).resolve():
                raise RuntimeError('Service is not running system Node')
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as response:
                if response.status != 200 or b'<html' not in response.read().lower():
                    raise RuntimeError('Frontend unavailable')
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/status', timeout=3) as response:
                status = json.load(response)
                if status.get('status') != 'healthy':
                    raise RuntimeError(f'API health: {status.get("status")}')
            print('Healthy frontend, API and system Node process', flush=True)
            return
        except (OSError, ValueError, RuntimeError) as error:
            last = str(error)
            time.sleep(1)
    raise RuntimeError(f'Health check failed: {last}')


def activate(version, allow_newer_schema):
    target = release_path(version)
    validate(target)
    config = read_env()
    if config.get('EMU_MEDIA_API_KEY'):
        request = urllib.request.Request(
            config['HERMES_BASE_URL'].rstrip('/') + '/v1/emu-media/capabilities',
            headers={'Authorization': 'Bearer ' + config['EMU_MEDIA_API_KEY']})
        with urllib.request.urlopen(request, timeout=10) as response:
            if json.load(response).get('protocol_version') != 1:
                raise RuntimeError('Media plugin protocol must be v1')
    if not compatible(target) and not allow_newer_schema:
        raise RuntimeError('Database has newer migrations than target; review compatibility first. '
                           'Use --allow-newer-schema only after that review; no database restore is performed.')
    old = (BASE / 'current').resolve()
    if old == target:
        raise RuntimeError('Target is already current')
    run('systemctl', '--user', 'stop', 'emu-chat.service')
    try:
        saved = backup()
    except Exception:
        run('systemctl', '--user', 'start', 'emu-chat.service')
        raise
    try:
        point(target)
        run('systemctl', '--user', 'start', 'emu-chat.service')
        healthy(target, config)
    except Exception:
        run('systemctl', '--user', 'stop', 'emu-chat.service')
        if compatible(old) and info(old).get('node_abi') == output(NODE, '-p', 'process.versions.modules'):
            point(old)
            run('systemctl', '--user', 'start', 'emu-chat.service')
            healthy(old, config)
            print('Previous code restarted; database was not restored', flush=True)
        else:
            print(f'Service stopped. Automatic code rollback is incompatible. Backup: {saved}. '
                  'Review migrations and external state before recovery.', file=sys.stderr, flush=True)
        raise
    atomic_text(BASE / 'previous', old.name + '\n')
    old_info = info(old)
    if old_info:
        old_info['status'] = 'inactive'
        write_info(old, old_info)
    metadata = info(target)
    metadata.update(status='active', switched_at=now(), previous=old.name,
                    backup=str(saved), runtime_node_version=output(NODE, '--version'))
    write_info(target, metadata)
    print(f'Activated {version}; previous={old.name}', flush=True)


def schedule(version, allow_newer_schema):
    validate(release_path(version))
    unit = 'emu-chat-deploy-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
    args = [sys.executable, str(Path(__file__).resolve()), '_activate', version]
    if allow_newer_schema:
        args.append('--allow-newer-schema')
    run('systemd-run', '--user', f'--unit={unit}', '--collect', '--property=Type=exec',
        '--property=UMask=0077', '--property=Environment=PATH=/usr/bin:/bin', *args)
    print(f'Deployment queued. Inspect completion: journalctl --user -u {unit} -f', flush=True)
    print(f'Unit: {unit}.service', flush=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    create = commands.add_parser('build')
    create.add_argument('version')
    create.add_argument('ref', nargs='?')
    for action in ('deploy', 'switch', 'rollback', '_activate'):
        command = commands.add_parser(action)
        command.add_argument('version', nargs='?' if action == 'rollback' else None)
        command.add_argument('--allow-newer-schema', action='store_true')
    commands.add_parser('list')
    args = parser.parse_args()
    if args.action == 'list':
        current = (BASE / 'current').resolve()
        for path in sorted(RELEASES.glob('*')):
            if path.is_dir() and not path.name.startswith('.'):
                data = info(path)
                print('*' if path == current else ' ', path.name, data.get('short_commit', '?'),
                      data.get('node_version', '?'))
        pid = output('systemctl', '--user', 'show', 'emu-chat.service', '-p', 'MainPID', '--value')
        print('Running directory:', Path(f'/proc/{pid}/cwd').resolve() if pid != '0' else '(stopped)')
    elif args.action == 'build':
        with locked():
            build(args.version, args.ref)
    elif args.action == '_activate':
        with locked():
            activate(args.version, args.allow_newer_schema)
    else:
        version = args.version
        if version is None:
            version = (BASE / 'previous').read_text().strip()
        schedule(version, args.allow_newer_schema)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, sqlite3.Error) as error:
        print(f'Error: {error}', file=sys.stderr, flush=True)
        sys.exit(1)

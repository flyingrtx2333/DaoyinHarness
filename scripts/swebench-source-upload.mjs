// Public exact-base source transfer only. No login, model call or remote action at import.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DATASET_REVISION = 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a';
const IDS = ['pytest-dev__pytest-5787', 'pytest-dev__pytest-5631', 'sympy__sympy-12481'];
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error('Prepared public source transfer failed its bounded evidence or safety contract.'), { code });
const below = (parent, child) => {
  const path = relative(parent, child);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

async function boundedRegularFile(path, parent, maximum) {
  const actual = await realpath(path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || !below(parent, actual) || info.size < 1 || info.size > maximum) {
    throw fail('SWE_SOURCE_LOCAL_FILE_INVALID');
  }
  const bytes = await readFile(actual);
  if (bytes.length !== info.size || bytes.length > maximum) throw fail('SWE_SOURCE_LOCAL_FILE_CHANGED');
  return { actual, bytes };
}

/** Validate only the fixed issue manifest and prepared public-source archives. */
export async function loadPreparedSources({ root, issueManifestText, manifest }) {
  const actualRoot = await realpath(root);
  const directory = join(actualRoot, '.cache', 'swebench-sources');
  if (await realpath(directory) !== directory) throw fail('SWE_SOURCE_CACHE_ESCAPE');
  if (typeof issueManifestText !== 'string' || issueManifestText.length > 100_000 ||
      manifest?.datasetRevision !== DATASET_REVISION || manifest.referencePatchExposed !== false ||
      manifest.testPatchExposed !== false || !Array.isArray(manifest.tasks) || manifest.tasks.length !== IDS.length) {
    throw fail('SWE_SOURCE_ISSUE_MANIFEST_INVALID');
  }
  if (JSON.stringify(JSON.parse(issueManifestText)) !== JSON.stringify(manifest)) throw fail('SWE_SOURCE_ISSUE_MANIFEST_CHANGED');
  const text = await boundedRegularFile(join(directory, 'manifest.json'), directory, 128 * 1024);
  const prepared = JSON.parse(text.bytes.toString('utf8'));
  if (prepared.kind !== 'swebench-exact-base-source-archives' || prepared.datasetRevision !== DATASET_REVISION ||
      prepared.issueManifestSha256 !== digest(issueManifestText) || prepared.referencePatchExposed !== false ||
      prepared.testPatchExposed !== false || !Array.isArray(prepared.cases) || prepared.cases.length !== IDS.length) {
    throw fail('SWE_SOURCE_MANIFEST_PROVENANCE_INVALID');
  }
  const sources = new Map();
  for (let index = 0; index < IDS.length; index += 1) {
    const task = manifest.tasks[index];
    const entry = prepared.cases[index];
    if (task?.instance_id !== IDS[index] || entry?.instance_id !== IDS[index] || entry.repo !== task.repo ||
        entry.baseCommit !== task.base_commit || !/^[a-f0-9]{40}$/u.test(entry.baseCommit ?? '') ||
        !/^[a-f0-9]{40}$/u.test(entry.tree ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repo ?? '') ||
        entry.source?.clean !== true || entry.source.shallow !== true || entry.source.head !== entry.baseCommit ||
        entry.source.tree !== entry.tree || entry.source.commitCount !== 1 || !Array.isArray(entry.source.refs) || entry.source.refs.length !== 0 ||
        (entry.source.remote !== undefined && entry.source.remote !== `https://github.com/${entry.repo}.git`) ||
        typeof entry.archive?.file !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.archive.sha256 ?? '') ||
        !Number.isSafeInteger(entry.archive.bytes) || entry.archive.bytes < 1 || entry.archive.bytes > MAX_ARCHIVE_BYTES) {
      throw fail('SWE_SOURCE_CASE_PROVENANCE_INVALID');
    }
    const archive = await boundedRegularFile(resolve(actualRoot, entry.archive.file), directory, MAX_ARCHIVE_BYTES);
    if (archive.bytes.length !== entry.archive.bytes || digest(archive.bytes) !== entry.archive.sha256 ||
        archive.bytes[0] !== 0x1f || archive.bytes[1] !== 0x8b) throw fail('SWE_SOURCE_ARCHIVE_INTEGRITY_INVALID');
    // Do not carry unknown manifest fields, full dataset rows or any archive bytes into reports.
    sources.set(entry.instance_id, Object.freeze({ instance_id: entry.instance_id, repo: entry.repo,
      baseCommit: entry.baseCommit, tree: entry.tree, archiveBuffer: archive.bytes,
      archive: Object.freeze({ file: archive.actual, sha256: entry.archive.sha256, bytes: entry.archive.bytes }),
      source: Object.freeze({ clean: true, shallow: true, head: entry.baseCommit, tree: entry.tree, commitCount: 1, refs: [] }),
      preparedManifest: Object.freeze({ file: text.actual, sha256: digest(text.bytes), issueManifestSha256: prepared.issueManifestSha256 }) }));
  }
  return sources;
}

// Fixed trusted code; no model-produced command, archive field or path becomes Python code.
const EXTRACT = String.raw`
import configparser, hashlib, json, os, pathlib, posixpath, re, stat, subprocess, sys, tarfile, tempfile

def reject(code):
    raise ValueError(code)

def reserved(name):
    first = name.split('/')[0]
    return first in ('.harness', 'lost+found') or first.startswith('.harness-restore-')

def normal(name):
    if not isinstance(name, str) or not name or len(name.encode('utf-8')) > 4096 or '\\' in name or ':' in name or any(ord(c) < 32 for c in name):
        reject('ARCHIVE_PATH_INVALID')
    name = name.rstrip('/')
    parts = name.split('/')
    if len(parts) > 128 or any(p in ('', '.', '..') for p in parts) or reserved(name):
        reject('ARCHIVE_PATH_RESERVED_OR_ESCAPE')
    return name

def git(args):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM='/dev/null', GIT_CONFIG_GLOBAL='/dev/null', GIT_OPTIONAL_LOCKS='0')
    with tempfile.TemporaryFile() as output:
        p = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] + args, cwd=root, env=env, stdout=output, stderr=subprocess.DEVNULL, timeout=30)
        output.seek(0)
        value = output.read(65537)
    if p.returncode != 0 or len(value) > 65536:
        reject('GIT_SOURCE_VERIFICATION_FAILED')
    return value.decode('utf-8').strip()

def fresh(allowed):
    for p in root.iterdir():
        if p.name in allowed:
            if p.is_symlink() or not p.is_dir(): reject('UPLOAD_DIRECTORY_INVALID')
        elif not reserved(p.name):
            reject('SOURCE_WORKSPACE_NOT_FRESH')

def main():
    global root
    mode, directory, expected_hash, expected_size, count, base, tree = sys.argv[1:]
    if not re.fullmatch(r'__swe_source_upload_[a-f0-9]{32}', directory) or not re.fullmatch(r'[a-f0-9]{64}', expected_hash) or not re.fullmatch(r'[a-f0-9]{40}', base) or not re.fullmatch(r'[a-f0-9]{40}', tree):
        reject('UPLOAD_ARGUMENT_INVALID')
    expected_size, count = int(expected_size), int(count)
    if not 0 < expected_size <= 33554432 or not 0 < count <= 256:
        reject('UPLOAD_BOUND_INVALID')
    root = pathlib.Path.cwd().resolve()
    stage = root / directory
    if mode == 'prepare':
        fresh(set())
        if os.path.lexists(stage): reject('UPLOAD_DIRECTORY_COLLISION')
        stage.mkdir(mode=0o700)
        return {'status':'prepared', 'directory':directory}
    if mode != 'extract': reject('UPLOAD_MODE_INVALID')
    fresh({directory})
    expected_names = {'chunk-%05d.bin' % i for i in range(count)}
    if {p.name for p in stage.iterdir()} != expected_names:
        reject('UPLOAD_CHUNK_SET_INVALID')
    archive = stage / 'source.tar.gz'
    checksum = hashlib.sha256()
    size = 0
    with archive.open('xb') as output:
        for i in range(count):
            chunk = stage / ('chunk-%05d.bin' % i)
            info = chunk.lstat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 131072:
                reject('UPLOAD_CHUNK_INVALID')
            data = chunk.read_bytes()
            if len(data) != info.st_size or (i < count - 1 and len(data) != 131072):
                reject('UPLOAD_CHUNK_LENGTH_INVALID')
            checksum.update(data)
            size += len(data)
            if size > expected_size: reject('UPLOAD_SIZE_EXCEEDED')
            output.write(data)
    if size != expected_size or checksum.hexdigest() != expected_hash:
        reject('UPLOAD_ARCHIVE_INTEGRITY_FAILED')
    with tarfile.open(archive, 'r:gz') as tar:
        members, names, links = [], {}, {}
        expanded = 0
        for m in tar:
            if len(members) >= 100000: reject('ARCHIVE_ENTRY_LIMIT')
            name = normal(m.name)
            if name == directory or name.startswith(directory + '/') or name in names:
                reject('ARCHIVE_COLLISION_OR_DUPLICATE')
            if not (m.isfile() or m.isdir() or m.issym()) or m.islnk() or m.mode & 0o7000 or m.size < 0:
                reject('ARCHIVE_MEMBER_TYPE_INVALID')
            if m.isfile():
                expanded += m.size
                if expanded > 268435456: reject('ARCHIVE_EXPANSION_LIMIT')
            if name == '.git' or name.startswith('.git/'):
                if m.issym() or name.startswith(('.git/hooks/', '.git/logs/')) or name in ('.git/hooks', '.git/logs'):
                    reject('ARCHIVE_GIT_EXECUTION_METADATA')
                if m.isfile() and name not in ('.git/HEAD', '.git/index', '.git/shallow', '.git/config') and not re.fullmatch(r'\.git/objects/(?:[a-f0-9]{2}/[a-f0-9]{38}|pack/pack-[a-f0-9]{40}\.(?:pack|idx|rev))', name):
                    reject('ARCHIVE_GIT_METADATA_INVALID')
            if m.issym():
                if not m.linkname or '\\' in m.linkname or ':' in m.linkname or m.linkname.startswith('/') or any(ord(c) < 32 for c in m.linkname):
                    reject('ARCHIVE_LINK_INVALID')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.linkname))
                if target in ('.', '..') or target.startswith('../') or reserved(target) or target.split('/')[0] == directory:
                    reject('ARCHIVE_LINK_ESCAPE')
                links[name] = target
            tarfile.data_filter(m, str(root))
            names[name] = m
            members.append(m)
        for name in names:
            parts = name.split('/')
            if any('/'.join(parts[:i]) in links for i in range(1, len(parts))):
                reject('ARCHIVE_LINK_PARENT')
        for name in links:
            seen = set()
            target = name
            while target in links:
                if target in seen or len(seen) >= 128: reject('ARCHIVE_LINK_CYCLE')
                seen.add(target)
                target = links[target]
            parts = target.split('/')
            if any('/'.join(parts[:i]) in links for i in range(1, len(parts))):
                reject('ARCHIVE_LINK_CHAIN_PARENT')
        if '.git/HEAD' not in names or '.git/shallow' not in names or '.git/config' not in names or '.git/index' not in names:
            reject('ARCHIVE_GIT_REQUIRED_METADATA_MISSING')
        def small(name, bound):
            member = names[name]
            if not member.isfile() or member.size > bound: reject('ARCHIVE_GIT_METADATA_LIMIT')
            return tar.extractfile(member).read(bound + 1).decode('utf-8')
        if small('.git/HEAD', 100).strip() != base or small('.git/shallow', 100).strip() != base:
            reject('ARCHIVE_HEAD_OR_SHALLOW_MISMATCH')
        config = configparser.ConfigParser(interpolation=None, strict=True)
        config.read_string(small('.git/config', 16384))
        if config.defaults() or config.sections() != ['core'] or dict(config['core']) != {'repositoryformatversion':'0', 'filemode':'true', 'bare':'false', 'logallrefupdates':'false'}:
            reject('ARCHIVE_GIT_CONFIG_INVALID')
        # No archive member may replace any pre-existing workspace entry.
        for name in {name.split('/')[0] for name in names}:
            if os.path.lexists(root / name): reject('ARCHIVE_TARGET_EXISTS')
        tar.extractall(root, members=members, filter='data')
    if git(['rev-parse','HEAD']) != base or git(['rev-parse','HEAD^{tree}']) != tree or git(['rev-parse','--is-shallow-repository']) != 'true' or git(['rev-list','--count','HEAD']) != '1' or git(['for-each-ref','--format=%(refname)']):
        reject('GIT_BASE_IDENTITY_MISMATCH')
    scope = ['.', ':(top,exclude).harness', ':(top,exclude,glob).harness-restore-*', ':(top,exclude,glob).harness-restore-*/**', ':(top,exclude)lost+found', ':(top,exclude,literal)' + directory]
    if git(['status','--porcelain','--untracked-files=all','--'] + scope):
        reject('GIT_SOURCE_NOT_CLEAN')
    for name in expected_names: (stage / name).unlink()
    archive.unlink()
    stage.rmdir()
    return {'status':'extracted-and-verified', 'archiveSha256':expected_hash, 'archiveBytes':size, 'entries':len(members), 'expandedBytes':expanded, 'head':base, 'tree':tree, 'shallow':True, 'commitCount':1, 'clean':True, 'refs':[], 'ownedTemporaryFilesRemoved':True}

try:
    print(json.dumps(main(), separators=(',',':')))
except Exception as error:
    code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]{1,80}', str(error)) else 'SOURCE_VALIDATION_FAILED'
    print(json.dumps({'status':'rejected','code':code}, separators=(',',':')))
    sys.exit(1)
`;

/** Transfer once via ordinary resource controls, then verify/extract inside gVisor. */
export async function uploadPreparedSource({ item, source, control, sandboxProcess, save }) {
  if (!source || source.instance_id !== item?.instance_id || !Buffer.isBuffer(source.archiveBuffer) ||
      source.archiveBuffer.length !== source.archive.bytes || digest(source.archiveBuffer) !== source.archive.sha256 ||
      source.archive.bytes < 1 || source.archive.bytes > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{40}$/u.test(source.baseCommit ?? '') ||
      !/^[a-f0-9]{40}$/u.test(source.tree ?? '') || !/^[a-f0-9]{64}$/u.test(source.archive.sha256 ?? '') ||
      typeof control !== 'function' || typeof sandboxProcess !== 'function' || typeof save !== 'function') {
    throw fail('SWE_SOURCE_UPLOAD_INPUT_INVALID');
  }
  if (item.sourceUpload !== undefined) throw fail('SWE_SOURCE_UPLOAD_RESUBMISSION_FORBIDDEN');
  const directory = `__swe_source_upload_${randomUUID().replaceAll('-', '')}`;
  const chunks = Math.ceil(source.archive.bytes / CHUNK_BYTES);
  item.sourceUpload = { status: 'planned', directory, source: 'locally-fetched-public-exact-base-archive',
    archive: source.archive, preparedManifest: source.preparedManifest, chunks: [], mutatingResubmissions: 0,
    limits: { archiveBytes: MAX_ARCHIVE_BYTES, chunkBytes: CHUNK_BYTES, entries: 100_000, expandedBytes: 256 * 1024 * 1024 },
    expectedHead: source.baseCommit, expectedTree: source.tree };
  await save();
  const execute = async mode => {
    const result = await sandboxProcess('python', ['-c', EXTRACT, mode, directory, source.archive.sha256,
      String(source.archive.bytes), String(chunks), source.baseCommit, source.tree], 120_000);
    if (result.exitCode !== 0 || result.sandbox !== 'gVisor' || result.timedOut === true ||
        typeof result.stdout !== 'string' || result.stdout.length > 16_384 || (result.stderr ?? '').length > 16_384) {
      throw fail('SWE_SOURCE_EXTRACTION_PROCESS_INVALID');
    }
    let receipt;
    try { receipt = JSON.parse(result.stdout); } catch { throw fail('SWE_SOURCE_EXTRACTION_RECEIPT_INVALID'); }
    return receipt;
  };
  try {
    const prepared = await execute('prepare');
    if (prepared.status !== 'prepared' || prepared.directory !== directory) throw fail('SWE_SOURCE_UPLOAD_DIRECTORY_INVALID');
    item.sourceUpload.status = 'uploading';
    await save();
    for (let index = 0; index < chunks; index += 1) {
      const bytes = source.archiveBuffer.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      const path = `${directory}/chunk-${String(index).padStart(5, '0')}.bin`;
      const expectedDigest = `sha256:${digest(bytes)}`;
      // Never repeat a mutating request after an uncertain response.
      const written = await control('file_write', { path, contentBase64: bytes.toString('base64') }, 30_000);
      if (written.path !== path || written.size !== bytes.length || written.digest !== expectedDigest) {
        throw fail('SWE_SOURCE_UPLOAD_CHUNK_RECEIPT_INVALID');
      }
      item.sourceUpload.chunks.push({ index, path, bytes: written.size, digest: written.digest });
      await save();
    }
    item.sourceUpload.status = 'extracting';
    await save();
    const extracted = await execute('extract');
    if (extracted.status !== 'extracted-and-verified' || extracted.archiveSha256 !== source.archive.sha256 ||
        extracted.archiveBytes !== source.archive.bytes || extracted.head !== source.baseCommit || extracted.tree !== source.tree ||
        extracted.clean !== true || extracted.shallow !== true || extracted.commitCount !== 1 ||
        extracted.ownedTemporaryFilesRemoved !== true || !Array.isArray(extracted.refs) || extracted.refs.length !== 0 ||
        !Number.isSafeInteger(extracted.entries) || extracted.entries < 1 || extracted.entries > 100_000 ||
        !Number.isSafeInteger(extracted.expandedBytes) || extracted.expandedBytes < 1 || extracted.expandedBytes > 256 * 1024 * 1024) {
      throw fail('SWE_SOURCE_EXTRACTION_RECEIPT_INVALID');
    }
    item.sourceUpload.status = 'extracted-and-verified';
    item.sourceUpload.extraction = extracted;
    await save();
    return extracted;
  } catch (error) {
    item.sourceUpload.status = 'failed-no-resubmission';
    item.sourceUpload.failure = { code: String(error.code ?? 'SWE_SOURCE_UPLOAD_FAILED'),
      message: 'Actual source upload or extraction did not complete its bounded contract; retained ordinary operation receipts identify the failing stage.' };
    await save();
    throw error;
  }
}

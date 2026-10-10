// Install independently verified, published reference media into the existing blob store.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, mkdir, chown, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const source = arg('--source'), contentRoot = arg('--content-root');
if (process.platform !== 'linux' || !source || !contentRoot || !isAbsolute(source) || !isAbsolute(contentRoot))
  throw new Error('Independent Linux server, --source and --content-root absolute directories required.');
const sourceRoot = await realpath(source), root = await realpath(contentRoot), owner = await stat(root);
if (!owner.isDirectory() || !(await stat(sourceRoot)).isDirectory()) throw new Error('Existing directories required.');
const catalog = execFileSync('git', ['show', 'HEAD:packages/server-cloud/src/resources/campfire-presets.ts'], { encoding: 'utf8' });
const presets = JSON.parse(catalog.slice(catalog.indexOf('['), catalog.lastIndexOf(']') + 1));
const hash = data => createHash('sha256').update(data).digest('hex');
for (const preset of presets) {
  if (!/^preset_[a-z0-9-]+_v[1-9][0-9]*$/.test(preset.key) || !/^sha256:[a-f0-9]{64}$/.test(preset.digest)) throw new Error('Invalid committed preset identity.');
  const file = join(sourceRoot, preset.key.replace('preset_', 'preset_reference_') + '.mp4');
  if (dirname(await realpath(file)) !== sourceRoot) throw new Error('Reference source escapes its directory.');
  const data = await readFile(file), digest = preset.digest.slice(7);
  if (data.length !== preset.size || hash(data) !== digest || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('Published reference integrity mismatch.');
  const target = join(root, digest.slice(0, 2), digest.slice(2, 4), digest);
  try { if (hash(await readFile(target)) !== digest) throw new Error('Existing content integrity mismatch.'); continue; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  for (const directory of [dirname(dirname(target)), dirname(target)]) {
    if (!(await realpath(directory)).startsWith(root + '/')) throw new Error('Content directory escapes its root.');
    await chown(directory, owner.uid, owner.gid);
  }
  const temporary = target + '.preset-' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data); await handle.sync(); await handle.chown(owner.uid, owner.gid);
    try { await link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST' || hash(await readFile(target)) !== digest) throw error; }
  } finally { await handle.close(); await unlink(temporary); }
}
console.log(JSON.stringify({ installed: presets.map(item => item.key), verified: true }));

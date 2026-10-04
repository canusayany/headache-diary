import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageInstaller } from '../scripts/stage-installer.mjs';

const SOURCES = [
  'index.html', 'app.js', 'model.js', 'reports.js', 'charts.js', 'styles.css', 'sw.js', 'server.js',
  'manifest.webmanifest', 'launch.ps1', 'launch.vbs', 'icons/app.svg', 'icons/app.ico',
  'icons/app-192.png', 'icons/app-512.png', 'installer/使用说明-安装版.md', '安装说明.md',
  'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'installer/runtime-support.ps1',
];
const PAYLOAD = [
  'index.html', 'app.js', 'model.js', 'reports.js', 'charts.js', 'styles.css', 'sw.js', 'server.js',
  'manifest.webmanifest', 'launch.ps1', 'launch.vbs', 'icons/app.svg', 'icons/app.ico',
  'icons/app-192.png', 'icons/app-512.png', '使用说明.md', '安装说明.md',
  'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'runtime-support.ps1', 'package.json', 'installation.json',
  'runtime/node.exe', 'runtime/LICENSE.txt', 'build-meta.json', 'payload-manifest.json',
].sort();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function write(filename, bytes) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, bytes);
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-package-'));
  context.after(async () => {
    const absolute = path.resolve(root), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('headache-package-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const projectDirectory = path.join(root, '项目 中文 路径');
  const runtimeDirectory = path.join(root, '官方 Node 文件');
  const outputDirectory = path.join(root, '安装 载荷 staging');
  for (const source of SOURCES) await write(path.join(projectDirectory, source), `fixture: ${source}\n`);
  await write(path.join(projectDirectory, 'package.json'), JSON.stringify({ type: 'module', name: 'headache-test', version: '1.2.3', license: 'MIT', private: true, scripts: { test: 'DO-NOT-SHIP' }, devDependencies: { secret: '*' }, patient: 'DO-NOT-SHIP' }));
  await write(path.join(runtimeDirectory, 'node.exe'), Buffer.from([0x4d, 0x5a, 0x10, 0x20, 0x30]));
  await write(path.join(runtimeDirectory, 'LICENSE'), 'Fixture license used only in unit tests.\n');
  return { root, projectDirectory, runtimeDirectory, outputDirectory };
}

async function files(directory, relative = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await files(directory, name));
    else result.push(name);
  }
  return result.sort();
}

test('installer staging ships only the explicit allowlist, bundled runtime, and installer-specific documentation', async (context) => {
  const options = await fixture(context);
  for (const excluded of ['data/state.json', 'data/backups/private.json', 'tests/private-record.json', 'node_modules/private/index.js', 'screenshots/patient.png', 'icons/patient.png', '使用说明.md', 'installation.json', 'package-lock.json', '.env']) {
    await write(path.join(options.projectDirectory, excluded), 'PRIVATE-HEALTH-SENTINEL');
  }
  const result = await stageInstaller({ ...options, runtimeVersion: 'v24.19.0' });
  assert.deepEqual(await files(result.outputDirectory), PAYLOAD);
  const minimalPackage = JSON.parse(await fs.readFile(path.join(result.outputDirectory, 'package.json'), 'utf8'));
  assert.deepEqual(minimalPackage, { type: 'module', name: 'headache-test', version: '1.2.3', license: 'MIT' });
  assert.equal(await fs.readFile(path.join(result.outputDirectory, 'LICENSE'), 'utf8'), 'fixture: LICENSE\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.outputDirectory, 'installation.json'), 'utf8')), { schemaVersion: 1, app: 'headache-diary', installMode: 'per-user', port: 17844 });
  assert.equal(await fs.readFile(path.join(result.outputDirectory, '使用说明.md'), 'utf8'), 'fixture: installer/使用说明-安装版.md\n');
  assert.equal(await fs.readFile(path.join(result.outputDirectory, 'runtime-support.ps1'), 'utf8'), 'fixture: installer/runtime-support.ps1\n');
  assert.deepEqual(await fs.readFile(path.join(result.outputDirectory, 'runtime/node.exe')), await fs.readFile(path.join(options.runtimeDirectory, 'node.exe')));
  assert.equal(await fs.readFile(path.join(result.outputDirectory, 'runtime/LICENSE.txt'), 'utf8'), await fs.readFile(path.join(options.runtimeDirectory, 'LICENSE'), 'utf8'));
  for (const relative of PAYLOAD) assert.ok(!(await fs.readFile(path.join(result.outputDirectory, relative))).includes(Buffer.from('PRIVATE-HEALTH-SENTINEL')), relative);
  const manifest = JSON.parse(await fs.readFile(path.join(result.outputDirectory, 'payload-manifest.json'), 'utf8'));
  assert.equal(manifest.app, 'headache-diary');
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), PAYLOAD.filter((name) => name !== 'payload-manifest.json'));
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(result.outputDirectory, entry.path));
    assert.equal(entry.size, bytes.length, entry.path);
    assert.equal(entry.sha256, digest(bytes), entry.path);
  }
  const meta = JSON.parse(await fs.readFile(path.join(result.outputDirectory, 'build-meta.json'), 'utf8'));
  assert.equal(meta.runtime.version, 'v24.19.0');
  assert.equal(meta.runtime.sha256, digest(await fs.readFile(path.join(options.runtimeDirectory, 'node.exe'))));
  assert.equal(result.fileCount, PAYLOAD.length);
});

test('identical inputs generate identical payloads across output paths and a repeated build', async (context) => {
  const options = await fixture(context);
  const first = await stageInstaller({ ...options, sourceDateEpoch: '0' });
  const snapshot = new Map(await Promise.all(PAYLOAD.map(async (relative) => [relative, await fs.readFile(path.join(first.outputDirectory, relative))])));
  const second = await stageInstaller({ ...options, outputDirectory: path.join(options.root, '第二个 输出'), sourceDateEpoch: '0' });
  await stageInstaller({ ...options, sourceDateEpoch: '0' });
  for (const [relative, bytes] of snapshot) {
    assert.deepEqual(await fs.readFile(path.join(second.outputDirectory, relative)), bytes, relative);
    assert.deepEqual(await fs.readFile(path.join(first.outputDirectory, relative)), bytes, relative);
  }
  assert.equal(JSON.parse(snapshot.get('build-meta.json').toString()).builtAt, '1970-01-01T00:00:00.000Z');
  assert.ok(!snapshot.get('payload-manifest.json').includes(Buffer.from(options.root)));
  assert.ok(!snapshot.get('build-meta.json').includes(Buffer.from(options.root)));
});

test('staging reflects source version and binary changes without preserving stale payload files', async (context) => {
  const options = await fixture(context);
  const first = await stageInstaller(options);
  const previousHash = first.nodeSha256;
  await write(path.join(options.runtimeDirectory, 'node.exe'), 'different runtime fixture');
  await write(path.join(options.projectDirectory, 'app.js'), 'changed application fixture');
  await write(path.join(options.projectDirectory, 'package.json'), JSON.stringify({ type: 'module', name: 'headache-test', version: '2.0.0' }));
  const second = await stageInstaller(options);
  assert.equal(second.version, '2.0.0');
  assert.notEqual(second.nodeSha256, previousHash);
  assert.equal(await fs.readFile(path.join(second.outputDirectory, 'app.js'), 'utf8'), 'changed application fixture');
  assert.deepEqual(await files(second.outputDirectory), PAYLOAD);
});

test('staging refuses destructive source/ancestor targets and preserves unexpected user files', async (context) => {
  const options = await fixture(context);
  for (const outputDirectory of [options.projectDirectory, options.runtimeDirectory, options.root, path.join(options.projectDirectory, 'data'), path.join(options.projectDirectory, 'icons')]) {
    await assert.rejects(stageInstaller({ ...options, outputDirectory }), /不能|只能/);
  }
  const staged = await stageInstaller(options);
  await write(path.join(staged.outputDirectory, 'data/state.json'), 'PATIENT-DATA-MUST-SURVIVE');
  const before = await fs.readFile(path.join(staged.outputDirectory, 'payload-manifest.json'));
  await assert.rejects(stageInstaller(options), /未授权内容/);
  assert.equal(await fs.readFile(path.join(staged.outputDirectory, 'data/state.json'), 'utf8'), 'PATIENT-DATA-MUST-SURVIVE');
  assert.deepEqual(await fs.readFile(path.join(staged.outputDirectory, 'payload-manifest.json')), before);
  const unowned = path.join(options.root, 'unowned-output');
  await write(path.join(unowned, 'index.html'), 'EXISTING-USER-FILE');
  await assert.rejects(stageInstaller({ ...options, outputDirectory: unowned }), /不是本工具生成/);
  assert.equal(await fs.readFile(path.join(unowned, 'index.html'), 'utf8'), 'EXISTING-USER-FILE');
});

test('missing required inputs fail without replacing an already complete stage', async (context) => {
  const options = await fixture(context);
  const first = await stageInstaller(options);
  const before = await fs.readFile(path.join(first.outputDirectory, 'payload-manifest.json'));
  await fs.unlink(path.join(options.runtimeDirectory, 'LICENSE'));
  await assert.rejects(stageInstaller(options), /缺少安装包所需文件.*LICENSE/);
  assert.deepEqual(await fs.readFile(path.join(first.outputDirectory, 'payload-manifest.json')), before);
  assert.ok(!(await fs.readdir(options.root)).some((name) => name.includes('.stage-') || name.includes('.previous-')));
});

test('directory junctions cannot bypass the source allowlist or redirect output over the project', async (context) => {
  const options = await fixture(context);
  const oldIcons = path.join(options.root, 'outside-icons');
  await fs.rename(path.join(options.projectDirectory, 'icons'), oldIcons);
  try { await fs.symlink(oldIcons, path.join(options.projectDirectory, 'icons'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { context.skip('当前账户不允许创建测试用链接。'); return; } throw error; }
  await assert.rejects(stageInstaller(options), /符号链接或目录联接/);
  await fs.unlink(path.join(options.projectDirectory, 'icons'));
  await fs.rename(oldIcons, path.join(options.projectDirectory, 'icons'));
  const outputLink = path.join(options.root, 'output-junction');
  await fs.symlink(options.projectDirectory, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageInstaller({ ...options, outputDirectory: outputLink }), /不能是符号链接/);
  const parentLink = path.join(options.root, 'parent-junction');
  await fs.symlink(options.projectDirectory, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageInstaller({ ...options, outputDirectory: path.join(parentLink, 'would-overwrite-source') }), /只能位于 dist/);
  assert.equal(await fs.readFile(path.join(options.projectDirectory, 'index.html'), 'utf8'), 'fixture: index.html\n');
});

test('the stage CLI accepts explicit input paths and environment output overrides', async (context) => {
  const options = await fixture(context);
  const script = fileURLToPath(new URL('../scripts/stage-installer.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--project-dir', options.projectDirectory, '--runtime-version', 'v24.19.0'], {
    encoding: 'utf8', env: { ...process.env, HEADACHE_NODE_RUNTIME_DIR: options.runtimeDirectory, HEADACHE_STAGE_DIR: options.outputDirectory, SOURCE_DATE_EPOCH: '0' }, timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(result.stdout).version, '1.2.3');
  assert.deepEqual(await files(options.outputDirectory), PAYLOAD);
  const invalid = spawnSync(process.execPath, [script, '--output'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /缺少值/);
});

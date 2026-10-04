import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROJECT = fileURLToPath(new URL('..', import.meta.url));
const APP = 'headache-diary';
const SOURCE_FILES = Object.freeze([
  ['index.html', 'index.html'], ['app.js', 'app.js'], ['model.js', 'model.js'],
  ['reports.js', 'reports.js'], ['charts.js', 'charts.js'], ['styles.css', 'styles.css'], ['sw.js', 'sw.js'],
  ['server.js', 'server.js'], ['manifest.webmanifest', 'manifest.webmanifest'],
  ['launch.ps1', 'launch.ps1'], ['launch.vbs', 'launch.vbs'],
  ['icons/app.svg', 'icons/app.svg'], ['icons/app.ico', 'icons/app.ico'],
  ['icons/app-192.png', 'icons/app-192.png'], ['icons/app-512.png', 'icons/app-512.png'],
  ['installer/使用说明-安装版.md', '使用说明.md'], ['安装说明.md', '安装说明.md'],
  ['LICENSE', 'LICENSE'], ['THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
  ['installer/runtime-support.ps1', 'runtime-support.ps1'],
]);
const GENERATED = ['package.json', 'installation.json', 'runtime/node.exe', 'runtime/LICENSE.txt', 'build-meta.json', 'payload-manifest.json'];
const ALLOWED = new Set([...SOURCE_FILES.map(([, destination]) => destination), ...GENERATED]);

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sourceFile(directory, relative) {
  const resolved = path.resolve(directory, relative);
  if (!inside(directory, resolved)) throw new Error(`源文件越出目录：${relative}`);
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    const current = path.join(directory, ...parts.slice(0, index + 1));
    const info = await exists(current);
    if (!info) throw new Error(`缺少安装包所需文件：${relative}`);
    if (info.isSymbolicLink()) throw new Error(`安装包源文件不能经过符号链接或目录联接：${relative}`);
    if (index === parts.length - 1) {
      if (!info.isFile() || !info.size) throw new Error(`安装包源文件必须是非空普通文件：${relative}`);
    } else if (!info.isDirectory()) throw new Error(`安装包源路径不是目录：${relative}`);
  }
  return resolved;
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJSON(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const item of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const info = await fs.lstat(path.join(directory, relative));
    if (info.isSymbolicLink()) throw new Error(`载荷目录不能包含链接：${relative}`);
    if (info.isDirectory()) {
      if (relative !== 'icons' && relative !== 'runtime') throw new Error(`载荷目录含有未授权内容：${relative}`);
      files.push(...await listFiles(directory, relative));
    } else if (info.isFile() && ALLOWED.has(relative)) files.push(relative);
    else throw new Error(`载荷目录含有未授权内容：${relative}`);
  }
  return files.sort();
}

async function ownedDestination(directory) {
  const info = await exists(directory);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('载荷输出不能是符号链接或普通文件。');
  const contents = await fs.readdir(directory);
  if (!contents.length) return true;
  // Never remove unexpected content, even from a previously generated stage.
  const files = await listFiles(directory);
  if (!files.includes('payload-manifest.json')) throw new Error('输出目录不是本工具生成的载荷；为保护现有文件，已拒绝覆盖。');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'payload-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.app !== APP) throw new Error('输出目录的载荷标记无效，已拒绝覆盖。');
  return true;
}

async function checkedOutput(project, runtime, requested) {
  const output = path.resolve(requested);
  if (output === path.parse(output).root || inside(output, project) || inside(output, runtime) || inside(runtime, output)) {
    throw new Error('输出不能覆盖项目、运行时源目录或其上级目录。');
  }
  if (inside(project, output) && !inside(path.join(project, 'dist'), output)) {
    throw new Error('项目内的载荷输出只能位于 dist 目录，不能覆盖源码或患者数据。');
  }
  await ownedDestination(output);
  return output;
}

async function canonicalPlannedPath(requested) {
  const suffix = [path.basename(requested)];
  let ancestor = path.dirname(requested);
  while (!(await exists(ancestor))) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('无法解析输出目录的已存在上级目录。');
    ancestor = parent;
  }
  return path.join(await fs.realpath(ancestor), ...suffix);
}

async function windowsProductVersion(filename) {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const info = await fs.stat(filename);
  if (info.size < 64) return null; // Permit inert, tiny runtime fixtures in tests.
  const handle = await fs.open(filename, 'r');
  const header = Buffer.alloc(64);
  try { await handle.read(header, 0, header.length, 0); }
  finally { await handle.close(); }
  if (header[0] !== 0x4d || header[1] !== 0x5a) return null;
  const command = "$ErrorActionPreference='Stop';$info=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:HEADACHE_STAGE_VERSION_FILE);[Console]::Out.Write($info.ProductVersion)";
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, HEADACHE_STAGE_VERSION_FILE: filename } });
  if (result.status !== 0) return null;
  const productVersion = result.stdout.trim();
  const match = /^v?(\d+\.\d+\.\d+)(?:\.0)?$/.exec(productVersion);
  return match ? { version: `v${match[1]}`, productVersion } : null;
}

function checkedSibling(parent, prefix, candidate) {
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('临时载荷路径检查失败，已停止文件操作。');
  }
  return resolved;
}

async function removeOwnedTemporary(parent, prefix, candidate) {
  const target = checkedSibling(parent, prefix, candidate);
  const info = await exists(target);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error('临时载荷被替换为链接，已停止清理。');
  // Validate both the resolved target and every child before recursive removal.
  await listFiles(target);
  await fs.rm(target, { recursive: true, force: true });
}

/** Build a deterministic, allowlisted installer payload; never reads data/. */
export async function stageInstaller({
  projectDirectory = DEFAULT_PROJECT,
  runtimeDirectory,
  outputDirectory,
  runtimeVersion = null,
  sourceDateEpoch = null,
} = {}) {
  const project = await fs.realpath(path.resolve(projectDirectory));
  const runtime = await fs.realpath(path.resolve(runtimeDirectory ?? path.join(project, 'build-tools/node-runtime')));
  const requestedOutput = await checkedOutput(project, runtime, outputDirectory ?? path.join(project, 'dist/staging'));
  const output = await checkedOutput(project, runtime, await canonicalPlannedPath(requestedOutput));
  if (runtimeVersion !== null && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(runtimeVersion)) throw new Error('Node 版本标记无效。');
  let builtAt;
  if (sourceDateEpoch !== null) {
    if (!['string', 'number'].includes(typeof sourceDateEpoch) || !/^\d+$/.test(String(sourceDateEpoch))) throw new Error('SOURCE_DATE_EPOCH 必须是有效的非负 Unix 秒数。');
    const epoch = Number(sourceDateEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isFinite(new Date(epoch * 1000).getTime())) throw new Error('SOURCE_DATE_EPOCH 必须是有效的非负 Unix 秒数。');
    builtAt = new Date(epoch * 1000).toISOString();
  }
  const packagePath = await sourceFile(project, 'package.json');
  const sourcePackage = JSON.parse((await fs.readFile(packagePath, 'utf8')).replace(/^\uFEFF/, ''));
  if (sourcePackage.type !== 'module' || typeof sourcePackage.name !== 'string' || !/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(sourcePackage.name) || sourcePackage.name.length > 214 || typeof sourcePackage.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(sourcePackage.version)) {
    throw new Error('源 package.json 的模块类型、名称或版本无效。');
  }
  const copies = [];
  for (const [source, destination] of SOURCE_FILES) copies.push([await sourceFile(project, source), destination]);
  const nodeSource = await sourceFile(runtime, 'node.exe');
  copies.push([nodeSource, 'runtime/node.exe']);
  copies.push([await sourceFile(runtime, 'LICENSE'), 'runtime/LICENSE.txt']);
  const actualVersion = await windowsProductVersion(nodeSource);
  if (actualVersion && runtimeVersion && actualVersion.version.slice(1) !== runtimeVersion.replace(/^v/, '')) throw new Error('指定 Node 版本与内置二进制的实际 ProductVersion 不一致。');

  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  // Recheck canonical paths in case an output ancestor is a junction.
  const canonicalOutput = path.join(realParent, path.basename(output));
  await checkedOutput(project, runtime, canonicalOutput);
  const prefix = `.${path.basename(output)}.stage-`;
  const previousPrefix = `.${path.basename(output)}.previous-`;
  const temporary = checkedSibling(realParent, prefix, path.join(realParent, `${prefix}${randomUUID()}`));
  const previous = checkedSibling(realParent, previousPrefix, path.join(realParent, `${previousPrefix}${randomUUID()}`));
  await fs.mkdir(temporary);
  let previousMoved = false, published = false;
  try {
    for (const [source, destination] of copies) {
      const target = path.join(temporary, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await writeJSON(path.join(temporary, 'package.json'), { type: 'module', name: sourcePackage.name, version: sourcePackage.version, ...(typeof sourcePackage.license === 'string' ? { license: sourcePackage.license } : {}) });
    await writeJSON(path.join(temporary, 'installation.json'), { schemaVersion: 1, app: APP, installMode: 'per-user', port: 17844 });
    const nodeHash = await sha256(path.join(temporary, 'runtime/node.exe'));
    const licenseHash = await sha256(path.join(temporary, 'runtime/LICENSE.txt'));
    await writeJSON(path.join(temporary, 'build-meta.json'), {
      schemaVersion: 1, app: APP, version: sourcePackage.version,
      installMode: 'per-user', port: 17844,
      runtime: {
        path: 'runtime/node.exe', version: actualVersion?.version ?? runtimeVersion,
        versionSource: actualVersion ? 'windows-product-version' : runtimeVersion ? 'supplied' : 'unknown',
        ...(actualVersion ? { productVersion: actualVersion.productVersion } : {}),
        sha256: nodeHash, licenseSha256: licenseHash,
      },
      ...(builtAt ? { builtAt } : {}),
    });
    const files = [];
    for (const relative of await listFiles(temporary)) {
      const filename = path.join(temporary, relative);
      files.push({ path: relative, size: (await fs.stat(filename)).size, sha256: await sha256(filename) });
    }
    const manifest = { schemaVersion: 1, app: APP, version: sourcePackage.version, files };
    // The manifest hashes every other payload file, not itself.
    await writeJSON(path.join(temporary, 'payload-manifest.json'), manifest);
    if (await ownedDestination(canonicalOutput)) {
      checkedSibling(realParent, previousPrefix, previous);
      await fs.rename(canonicalOutput, previous);
      previousMoved = true;
    }
    await fs.rename(temporary, canonicalOutput);
    published = true;
    if (previousMoved) await removeOwnedTemporary(realParent, previousPrefix, previous);
    return { outputDirectory: canonicalOutput, version: sourcePackage.version, fileCount: files.length + 1, nodeSha256: nodeHash, manifest };
  } catch (error) {
    if (previousMoved && !published && !(await exists(canonicalOutput))) await fs.rename(previous, canonicalOutput);
    if (!published) await removeOwnedTemporary(realParent, prefix, temporary);
    throw error;
  }
}

function parseArguments(arguments_) {
  const result = {};
  const options = { '--project-dir': 'projectDirectory', '--runtime-dir': 'runtimeDirectory', '--output': 'outputDirectory', '--runtime-version': 'runtimeVersion' };
  for (let index = 0; index < arguments_.length; index++) {
    const key = options[arguments_[index]];
    if (!key || !arguments_[index + 1] || arguments_[index + 1].startsWith('--')) throw new Error(`未知或缺少值的打包参数：${arguments_[index]}`);
    if (key in result) throw new Error(`重复的打包参数：${arguments_[index]}`);
    result[key] = arguments_[++index];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await stageInstaller({
      runtimeDirectory: process.env.HEADACHE_NODE_RUNTIME_DIR || undefined,
      outputDirectory: process.env.HEADACHE_STAGE_DIR || undefined,
      runtimeVersion: process.env.HEADACHE_NODE_VERSION || null,
      sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,
      ...parseArguments(process.argv.slice(2)),
    });
    console.log(JSON.stringify({ outputDirectory: result.outputDirectory, version: result.version, fileCount: result.fileCount, nodeSha256: result.nodeSha256 }, null, 2));
  } catch (error) {
    console.error(`安装载荷未生成：${error.message}`);
    process.exitCode = 1;
  }
}

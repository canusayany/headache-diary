import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const windows = { skip: process.platform !== 'win32', timeout: 45_000 };
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port !== 17843 && port !== 17844 && port !== 17845, '仅使用隔离测试端口');
  return port;
}

function run(executable, arguments_, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, arguments_, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('隔离脚本超过 30 秒未退出')); }, 30_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => setImmediate(() => {
      clearTimeout(timeout); child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, stdout, stderr, milliseconds: performance.now() - started });
    }));
  });
}

async function fixture(t, { bundledNode = true, installed = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-installer-test-'));
  const appRoot = path.join(directory, '中文 应用');
  const localData = path.join(directory, '用户 LocalAppData');
  const dataDirectory = installed ? path.join(localData, 'HeadacheDiary', 'data') : path.join(appRoot, 'data');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, LOCALAPPDATA: localData };
  let mockServer;
  let lastOwnedPid;
  const contextPath = path.join(appRoot, 'runtime-support.ps1');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.mkdir(localData);
  for (const file of ['server.js', 'model.js', 'launch.ps1', 'launch.vbs']) await fs.copyFile(path.join(sourceRoot, file), path.join(appRoot, file));
  let support = await fs.readFile(path.join(sourceRoot, 'installer', 'runtime-support.ps1'), 'utf8');
  if (!installed) support = support.replaceAll('17843', String(port));
  await fs.writeFile(contextPath, support);
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  const marker = { schemaVersion: 1, app: 'headache-diary', installMode: 'per-user', port };
  if (installed) await fs.writeFile(path.join(appRoot, 'installation.json'), JSON.stringify(marker));
  if (bundledNode) {
    await fs.mkdir(path.join(appRoot, 'runtime'));
    await fs.link(process.execPath, path.join(appRoot, 'runtime', 'node.exe')).catch(() => fs.copyFile(process.execPath, path.join(appRoot, 'runtime', 'node.exe')));
  }
  const launch = async () => {
    const result = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(appRoot, 'launch.ps1'), '-NoBrowser'], env);
    if (result.code === 0) { try { await identity(); } catch { } }
    return result;
  };
  const supportRun = action => run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', contextPath, action], env);
  const context = () => run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. ${psQuote(contextPath)}; Get-HeadacheRuntimeContext ${psQuote(appRoot)} | ConvertTo-Json -Compress`], env);
  const identity = async () => {
    const result = await (await fetch(`${base}/api/instance`)).json();
    if (result.appRoot === appRoot && result.dataDirectory === dataDirectory && result.port === port) lastOwnedPid = result.pid;
    return result;
  };
  const get = async () => (await fetch(`${base}/api/state`)).json();
  const put = state => fetch(`${base}/api/state`, { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ state, expectedRevision: state.revision }) });
  const mock = async identityValue => {
    let shutdownRequests = 0;
    mockServer = http.createServer((request, response) => {
      response.writeHead(request.url === '/api/instance' && identityValue === null ? 404 : 200, { 'Content-Type': 'application/json' });
      if (request.url === '/api/shutdown') shutdownRequests++;
      response.end(JSON.stringify(request.url === '/api/instance' ? identityValue : { app: 'headache-diary', version: 1 }));
    });
    await new Promise((resolve, reject) => { mockServer.once('error', reject); mockServer.listen(port, '127.0.0.1', resolve); });
    return () => shutdownRequests;
  };
  t.after(async () => {
    if (mockServer?.listening) await new Promise(resolve => mockServer.close(resolve));
    else {
      try {
        const current = await identity();
        if (current.appRoot === appRoot && current.dataDirectory === dataDirectory && current.port === port && current.installMode === 'per-user') {
          const stopped = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
          await stopped.json();
        } else if (current.appRoot === appRoot && !installed) {
          // Only this test's development child is forcibly cleaned up; support itself never does this.
          process.kill(current.pid);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch { /* Already stopped by the installer-support test. */ }
      if (lastOwnedPid) {
        const deadline = performance.now() + 8_000;
        let running = true;
        while (running && performance.now() < deadline) {
          try { process.kill(lastOwnedPid, 0); }
          catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
          if (running) await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(running, false, '独立测试服务必须已退出才能删除测试目录');
      }
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('headache-installer-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, appRoot, localData, dataDirectory, port, base, env, marker, contextPath, launch, supportRun, context, identity, get, put, mock };
}

test('安装标记启用独立用户病历目录，开发模式保留原 data 且不迁移文件', windows, async t => {
  const app = await fixture(t);
  await fs.mkdir(path.join(app.appRoot, 'data'));
  await fs.writeFile(path.join(app.appRoot, 'data', 'state.json'), 'original development bytes');
  const installed = await app.context();
  assert.equal(installed.code, 0, installed.stderr);
  const installedContext = JSON.parse(installed.stdout.trim());
  assert.equal(installedContext.DataDirectory, app.dataDirectory);
  assert.equal(installedContext.InstallMode, 'per-user');
  assert.equal(installedContext.Port, app.port);
  assert.equal(await fs.readFile(path.join(app.appRoot, 'data', 'state.json'), 'utf8'), 'original development bytes');
  await fs.unlink(path.join(app.appRoot, 'installation.json'));
  const development = await app.context();
  assert.equal(development.code, 0, development.stderr);
  const developmentContext = JSON.parse(development.stdout.trim());
  assert.equal(developmentContext.DataDirectory, path.join(app.appRoot, 'data'));
  assert.equal(developmentContext.InstallMode, 'application-directory');
  assert.equal(developmentContext.Port, 17843);
  assert.equal(await fs.stat(app.dataDirectory).then(() => true, () => false), false);
});

test('无效安装标记拒绝启动，不回退到开发 data 或创建病历目录', windows, async t => {
  const app = await fixture(t);
  const invalidMarkers = ['{broken', JSON.stringify({ ...app.marker, schemaVersion: 2 }), JSON.stringify({ ...app.marker, app: 'other-app' }), JSON.stringify({ ...app.marker, installMode: 'application-directory' }), JSON.stringify({ ...app.marker, port: 0 }), JSON.stringify({ ...app.marker, port: '17844' }), JSON.stringify({ ...app.marker, port: 65536 })];
  for (const marker of invalidMarkers) {
    await fs.writeFile(path.join(app.appRoot, 'installation.json'), marker);
    assert.equal((await app.launch()).code, 1);
  }
  assert.equal(await fs.stat(path.join(app.appRoot, 'data')).then(() => true, () => false), false);
  assert.equal(await fs.stat(app.dataDirectory).then(() => true, () => false), false);
});

test('安装版缺少内置 Node 时明确失败，禁止使用系统 Node 掩盖不完整安装', windows, async t => {
  const app = await fixture(t, { bundledNode: false });
  const launched = await app.launch();
  assert.equal(launched.code, 1);
  assert.equal(await fs.stat(app.dataDirectory).then(() => true, () => false), false);
  await assert.rejects(fetch(`${app.base}/api/health`));
});

test('已打包安装目录丢失 marker 时拒绝回退，保留原用户病历文件', windows, async t => {
  const app = await fixture(t);
  await fs.mkdir(app.dataDirectory, { recursive: true });
  const sentinel = Buffer.from('previous-user-record-bytes');
  await fs.writeFile(path.join(app.dataDirectory, 'state.json'), sentinel);
  await fs.unlink(path.join(app.appRoot, 'installation.json'));
  for (const metadata of ['build-meta.json', 'payload-manifest.json']) {
    await fs.writeFile(path.join(app.appRoot, metadata), '{}');
    assert.equal((await app.launch()).code, 1);
    assert.equal((await app.supportRun('-StopService')).code, 3);
    assert.deepEqual(await fs.readFile(path.join(app.dataDirectory, 'state.json')), sentinel);
    assert.equal(await fs.stat(path.join(app.appRoot, 'data')).then(() => true, () => false), false);
    await fs.unlink(path.join(app.appRoot, metadata));
  }
});

test('安装启动优先内置 Node、使用用户目录，并复用完全匹配的实例', windows, async t => {
  const app = await fixture(t);
  const launched = await app.launch();
  assert.equal(launched.code, 0, launched.stderr);
  const first = await app.identity();
  assert.equal(first.appRoot, app.appRoot);
  assert.equal(first.dataDirectory, app.dataDirectory);
  assert.equal(first.installMode, 'per-user');
  assert.equal(first.port, app.port);
  const executable = await run(powershell, ['-NoProfile', '-Command', `. ${psQuote(app.contextPath)}; Initialize-HeadacheInspectionModules; (Get-CimInstance Win32_Process -Filter 'ProcessId=${first.pid}').ExecutablePath`], app.env);
  assert.equal(executable.code, 0, executable.stderr);
  assert.equal(executable.stdout.trim().toLowerCase(), path.join(app.appRoot, 'runtime', 'node.exe').toLowerCase());
  const logBefore = await fs.readFile(path.join(app.dataDirectory, 'server.log'));
  assert.equal((await app.launch()).code, 0);
  assert.equal((await app.identity()).pid, first.pid);
  assert.deepEqual(await fs.readFile(path.join(app.dataDirectory, 'server.log')), logBefore);
  assert.equal(await fs.stat(path.join(app.appRoot, 'data')).then(() => true, () => false), false);
  assert.equal((await fs.stat(path.join(app.dataDirectory, 'server.error.log'))).size, 0);
  t.diagnostic(`隔离安装版冷启动到服务就绪 ${Math.round(launched.milliseconds)} ms；未打开浏览器。`);
});

test('端口上同产品但不同程序目录或病历目录的服务不可复用、不可停止', windows, async t => {
  const app = await fixture(t);
  const shutdownCount = await app.mock({ app: 'headache-diary', version: 1, appRoot: path.join(app.directory, '另一份安装'), dataDirectory: app.dataDirectory, port: app.port, pid: process.pid, installMode: 'per-user' });
  assert.equal((await app.launch()).code, 1);
  assert.equal((await app.supportRun('-StopService')).code, 3);
  assert.equal(shutdownCount(), 0);
  assert.equal((await fetch(`${app.base}/api/health`)).status, 200);
  assert.equal(await fs.stat(app.dataDirectory).then(() => true, () => false), false);
});

test('安装版拒绝只有旧 health 的开发服务，不发送 shutdown', windows, async t => {
  const app = await fixture(t);
  const shutdownCount = await app.mock(null);
  assert.equal((await app.launch()).code, 1);
  assert.equal((await app.supportRun('-StopService')).code, 3);
  assert.equal(shutdownCount(), 0);
});

test('程序目录相同但病历目录不同的实例也不可复用或停止', windows, async t => {
  const app = await fixture(t);
  const shutdownCount = await app.mock({ app: 'headache-diary', version: 1, appRoot: app.appRoot, dataDirectory: path.join(app.directory, 'foreign records'), port: app.port, pid: process.pid, installMode: 'per-user' });
  assert.equal((await app.launch()).code, 1);
  assert.equal((await app.supportRun('-StopService')).code, 3);
  assert.equal(shutdownCount(), 0);
  assert.equal((await fetch(`${app.base}/api/health`)).status, 200);
});

test('接口伪报匹配身份但 Node 命令行不属于安装目录时不停止任何进程', windows, async t => {
  const app = await fixture(t);
  const shutdownCount = await app.mock({ app: 'headache-diary', version: 1, appRoot: app.appRoot, dataDirectory: app.dataDirectory, port: app.port, pid: process.pid, installMode: 'per-user' });
  assert.equal((await app.supportRun('-StopService')).code, 3);
  assert.equal(shutdownCount(), 0);
  assert.equal((await fetch(`${app.base}/api/health`)).status, 200);
});

test('StopService 不停止开发实例，未运行的安装实例可以安全重复检查', windows, async t => {
  const app = await fixture(t, { installed: false });
  const launched = await app.launch();
  assert.equal(launched.code, 0, launched.stderr);
  assert.equal((await app.supportRun('-StopService')).code, 3);
  assert.equal((await fetch(`${app.base}/api/health`)).status, 200);
  const installed = await fixture(t);
  assert.equal((await installed.supportRun('-StopService')).code, 0);
  assert.equal((await installed.supportRun('-StopService')).code, 0);
  assert.equal(await fs.stat(installed.dataDirectory).then(() => true, () => false), false);
});

test('升级及模拟卸载停止自身服务，保留病历字节和备份，重新安装能读回', windows, async t => {
  const app = await fixture(t);
  assert.equal((await app.launch()).code, 0);
  const state = await app.get(); state.profile.name = 'isolated installer fixture';
  assert.equal((await app.put(state)).status, 200);
  const saved = await app.get(); saved.profile.theme = 'dark';
  assert.equal((await app.put(saved)).status, 200);
  const final = await app.get();
  const primary = path.join(app.dataDirectory, 'state.json');
  const primaryBytes = await fs.readFile(primary);
  const backupsBefore = await fs.readdir(path.join(app.dataDirectory, 'backups'));
  const stopped = await app.supportRun('-StopService');
  assert.equal(stopped.code, 0, stopped.stderr);
  await assert.rejects(fetch(`${app.base}/api/health`));
  assert.deepEqual(await fs.readFile(primary), primaryBytes);
  assert.deepEqual(await fs.readdir(path.join(app.dataDirectory, 'backups')), backupsBefore);
  await fs.copyFile(path.join(sourceRoot, 'server.js'), path.join(app.appRoot, 'server.js'));
  assert.equal((await app.launch()).code, 0);
  assert.deepEqual(await app.get(), final);
  const stopAgain = await app.supportRun('-StopService');
  assert.equal(stopAgain.code, 0, stopAgain.stderr);
  const markerCopy = await fs.readFile(path.join(app.appRoot, 'installation.json'));
  // Simulate only the install marker being removed/reinstalled; data is outside the app root.
  await fs.unlink(path.join(app.appRoot, 'installation.json'));
  assert.deepEqual(await fs.readFile(primary), primaryBytes);
  await fs.writeFile(path.join(app.appRoot, 'installation.json'), markerCopy);
  assert.equal((await app.launch()).code, 0);
  assert.deepEqual(await app.get(), final);
});

test('VBScript 无浏览器选项在含中文空格路径中启动同一安全链', windows, async t => {
  const app = await fixture(t);
  const wscript = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
  assert.equal((await run(wscript, [path.join(app.appRoot, 'launch.vbs'), '/NoBrowser'], app.env)).code, 0);
  const deadline = performance.now() + 7_000;
  let identity;
  while (performance.now() < deadline) {
    try { identity = await app.identity(); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(identity?.appRoot, app.appRoot);
  assert.equal(identity?.dataDirectory, app.dataDirectory);
  assert.equal(identity?.installMode, 'per-user');
});

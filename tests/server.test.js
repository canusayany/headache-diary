import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createAppServer } from '../server.js';
import { emptyState } from '../model.js';

const appDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.notEqual(port, 17843, '测试不能使用生产端口');
  assert.notEqual(port, 17845, '测试不能使用人工验收端口');
  return port;
}

async function removeTestDirectory(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('headache-diary-test-'));
  await fs.rm(directory, { recursive: true, force: true });
}

function rawRequest(app, { method = 'GET', pathname = '/api/state', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    // Each raw request owns its connection, including across server restarts.
    // A process-wide keep-alive pool can still contain the old server's socket
    // when the replacement begins listening on the same port.
    const request = http.request({ hostname: '127.0.0.1', port: app.port, path: pathname, method, headers, agent: false }, response => {
      const pieces = [];
      response.on('data', chunk => pieces.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(pieces).toString('utf8') }));
    });
    request.on('error', reject);
    if (chunks) { for (const chunk of chunks) request.write(chunk); request.end(); }
    else request.end(body);
  });
}

function runProcess(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, arguments_, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => setImmediate(() => {
      // A background server may inherit pipe handles from PowerShell after it exits.
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, signal, stdout, stderr, milliseconds: performance.now() - started });
    }));
  });
}

async function processFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-diary-test-'));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await stopped;
  };
  const start = async () => {
    child = spawn(process.execPath, [path.join(appDirectory, 'server.js')], {
      cwd: appDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HEADACHE_PORT: String(port), HEADACHE_DATA_DIR: directory },
    });
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`子进程未就绪：${output}`)), 5_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`子进程提前退出：${code} ${output}`)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Headache Diary ready')) { clearTimeout(timeout); resolve(); }
      });
      child.stderr.on('data', chunk => { output += chunk; });
    });
  };
  t.after(async () => { await stop(); await removeTestDirectory(directory); });
  await start();
  const get = () => rawRequest({ port });
  const put = (state, expectedRevision) => rawRequest({ port }, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ state, expectedRevision }),
  });
  return { directory, port, base, get, put, start, stop };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-diary-test-'));
  const port = await availablePort();
  let server;
  const start = async () => {
    server = createAppServer({ port, dataDirectory: directory });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  };
  const stop = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  await start();
  t.after(async () => {
    await stop();
    await removeTestDirectory(directory);
  });
  const base = `http://127.0.0.1:${port}`;
  const get = headers => fetch(`${base}/api/state`, { headers });
  const put = (state, expectedRevision, headers = {}) => fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify({ expectedRevision, state }),
  });
  return { directory, port, base, get, put, start, stop };
}

test('保存完整状态、递增版本，并在服务重启后保留磁盘记录', async t => {
  const app = await fixture(t);
  const initialResponse = await rawRequest(app);
  assert.equal(initialResponse.status, 200);
  const initial = JSON.parse(initialResponse.body);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial, { ...emptyState(), revision: 0 });
  initial.profile.name = '测试患者';
  initial.entries.push({
    id: 'test-attack-1', start: new Date(Date.now() - 3_600_000).toISOString(),
    end: new Date(Date.now() - 1_800_000).toISOString(), pain: 7,
    symptoms: ['畏光'], locations: ['左侧'], notes: '测试头痛记录',
    medications: [{ id: 'test-dose-1', name: '测试药物', dose: '测试剂量', at: new Date(Date.now() - 3_000_000).toISOString(), relief: 'partial' }],
  });
  const response = await rawRequest(app, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ state: initial, expectedRevision: 0 }),
  });
  assert.equal(response.status, 200);
  const saved = JSON.parse(response.body);
  assert.equal(saved.revision, 1);
  assert.equal(saved.entries[0].pain, 7);
  assert.equal(saved.entries[0].medications[0].relief, 'partial');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory, 'state.json'), 'utf8')), saved);
  await app.stop();
  await app.start();
  const restartedResponse = await rawRequest(app);
  assert.equal(restartedResponse.status, 200);
  assert.deepEqual(JSON.parse(restartedResponse.body), saved);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
});

test('并发保存只有一个成功，旧版本不会覆盖新版本', async t => {
  const app = await fixture(t);
  const state = emptyState();
  const responses = await Promise.all([app.put(state, 0), app.put(state, 0)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await (await app.get()).json()).revision, 1);
  const conflict = await app.put(state, 0);
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /另一窗口/);
});

test('每次覆盖前备份上一版本，并只保留最近 30 份', async t => {
  const app = await fixture(t);
  const state = emptyState();
  for (let revision = 0; revision < 34; revision++) {
    assert.equal((await app.put(state, revision)).status, 200);
  }
  const backups = (await fs.readdir(path.join(app.directory, 'backups'))).sort();
  assert.equal(backups.length, 30);
  const revisions = [];
  for (const name of backups) revisions.push(JSON.parse(await fs.readFile(path.join(app.directory, 'backups', name), 'utf8')).revision);
  assert.deepEqual(revisions.sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index + 4));
  assert.equal((await (await app.get()).json()).revision, 34);
});

test('损坏的主文件返回 503，保留原始内容，拒绝自动清空或覆盖', async t => {
  const app = await fixture(t);
  await app.put(emptyState(), 0);
  await app.put(emptyState(), 1);
  const primary = path.join(app.directory, 'state.json');
  const corrupt = Buffer.from('{"broken":');
  await fs.writeFile(primary, corrupt);
  const response = await app.get();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /未自动清空/);
  assert.equal((await app.put(emptyState(), 2)).status, 503);
  assert.deepEqual(await fs.readFile(primary), corrupt);
  assert.equal((await fs.readdir(path.join(app.directory, 'backups'))).length, 1);
});

test('主文件缺失但已有备份时不创建空白记录', async t => {
  const app = await fixture(t);
  await app.put(emptyState(), 0);
  await app.put(emptyState(), 1);
  await fs.unlink(path.join(app.directory, 'state.json'));
  const response = await app.get();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /仍有备份/);
  assert.equal((await app.put(emptyState(), 0)).status, 503);
  assert.equal((await fs.readdir(path.join(app.directory, 'backups'))).length, 1);
});

test('禁止跨站 API 请求、无 Origin 的写入和未知 Host', async t => {
  const app = await fixture(t);
  assert.equal((await app.put(emptyState(), 0, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.put(emptyState(), 0, { Origin: 'null' })).status, 403);
  assert.equal((await fetch(`${app.base}/api/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: emptyState(), expectedRevision: 0 }),
  })).status, 403);
  assert.equal((await app.get({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.get({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const hostDenied = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: app.port, path: '/api/state', headers: { Host: `evil.example:${app.port}` } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(hostDenied, 403);
  assert.equal((await app.get()).status, 200);
});

test('静态路由只提供应用文件，保护记录、脚本、测试和路径穿越', async t => {
  const app = await fixture(t);
  for (const route of ['/data/state.json', '/data/backups/a.json', '/server.js', '/launch.ps1', '/tests/server.test.js', '/README.md', '/.git/config']) {
    assert.equal((await fetch(app.base + route)).status, 404, route);
  }
  const traversal = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: app.port, path: '/%2e%2e/index.html' }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(traversal, 403);
  const health = await fetch(`${app.base}/api/health`);
  assert.deepEqual(await health.json(), { app: 'headache-diary', version: 1 });
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(health.headers.get('content-security-policy'), /script-src 'self'/);
});

test('拒绝无效版本、无效 JSON、过大的请求和存储故障', async t => {
  const app = await fixture(t);
  assert.equal((await app.put(emptyState(), -1)).status, 400);
  assert.equal((await app.put(emptyState(), 0.5)).status, 400);
  const malformed = await fetch(`${app.base}/api/state`, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${app.base}/api/state`, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  await app.put(emptyState(), 0);
  await fs.unlink(path.join(app.directory, 'state.json'));
  await fs.rmdir(app.directory);
  await fs.writeFile(app.directory, 'cannot be a data directory');
  assert.equal((await app.put(emptyState(), 0)).status, 503);
  assert.equal(await fs.readFile(app.directory, 'utf8'), 'cannot be a data directory');
});

test('16 个并发客户端争用同一版本时只提交一个完整状态', async t => {
  const app = await fixture(t);
  const candidates = Array.from({ length: 16 }, (_, index) => {
    const state = emptyState(); state.profile.name = `client-${index}`; return state;
  });
  const responses = await Promise.all(candidates.map(state => app.put(state, 0)));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 15);
  const winner = responses.findIndex(response => response.status === 200);
  const saved = await responses[winner].json();
  assert.equal(saved.profile.name, candidates[winner].profile.name);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await (await app.get()).json(), saved);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.directory, 'state.json'), 'utf8')), saved);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
});

test('连续保存同时读取时，每次读取都是完整版本而非半个文件', async t => {
  const app = await fixture(t);
  let completed = false;
  const saving = (async () => {
    try {
      for (let revision = 0; revision < 25; revision++) {
        const state = emptyState(); state.profile.name = `version-${revision + 1}`;
        assert.equal((await app.put(state, revision)).status, 200);
      }
    } finally { completed = true; }
  })();
  saving.catch(() => {});
  let reads = 0;
  while (!completed) {
    const response = await app.get();
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.profile.name, state.revision === 0 ? '' : `version-${state.revision}`);
    reads++;
  }
  await saving;
  assert.ok(reads > 1);
  assert.equal((await (await app.get()).json()).revision, 25);
});

test('备份目录失败不覆盖原文件，修复目录后同一版本可以重试', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  await fs.writeFile(path.join(app.directory, 'backups'), 'blocked');
  const updated = { ...first, profile: { ...first.profile, name: 'next' } };
  assert.equal((await app.put(updated, 1)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.deepEqual(await (await app.get()).json(), first);
  await fs.unlink(path.join(app.directory, 'backups'));
  assert.equal((await app.put(updated, 1)).status, 200);
  assert.equal((await (await app.get()).json()).profile.name, 'next');
  const [backup] = await fs.readdir(path.join(app.directory, 'backups'));
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'backups', backup)), originalBytes);
});

test('主文件 rename 失败时不宣称已保存，原文件完好且临时文件被清理', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const realRename = fs.rename.bind(fs);
  const failingRename = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(app.directory, 'state.json')) throw Object.assign(new Error('disk rename fault'), { code: 'EIO' });
    return realRename(from, to);
  });
  assert.equal((await app.put(first, 1)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
  assert.ok(!(await fs.readdir(path.join(app.directory, 'backups'))).some(name => name.endsWith('.tmp')));
  failingRename.mock.restore();
  assert.equal((await app.put(first, 1)).status, 200);
  assert.equal((await (await app.get()).json()).revision, 2);
});

test('fsync 失败保留上一版，不留下半写文件，并允许恢复后重试', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const realOpen = fs.open.bind(fs);
  const failingOpen = t.mock.method(fs, 'open', async (filename, ...arguments_) => {
    const handle = await realOpen(filename, ...arguments_);
    if (path.basename(filename).startsWith('.state-')) {
      handle.sync = async () => { throw Object.assign(new Error('fsync fault'), { code: 'EIO' }); };
    }
    return handle;
  });
  assert.equal((await app.put(first, 1)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
  failingOpen.mock.restore();
  assert.equal((await app.put(first, 1)).status, 200);
});

test('备份本身 rename 失败不修改主文件，也不留下损坏备份', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const realRename = fs.rename.bind(fs);
  const failingRename = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.dirname(to) === path.join(app.directory, 'backups')) throw Object.assign(new Error('backup rename fault'), { code: 'EIO' });
    return realRename(from, to);
  });
  assert.equal((await app.put(first, 1)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.deepEqual(await fs.readdir(path.join(app.directory, 'backups')), []);
  failingRename.mock.restore();
  assert.equal((await app.put(first, 1)).status, 200);
});

test('备份写到一半时磁盘空间不足，不留下可误认的 JSON 备份', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const realOpen = fs.open.bind(fs);
  const failingOpen = t.mock.method(fs, 'open', async (filename, ...arguments_) => {
    const handle = await realOpen(filename, ...arguments_);
    if (path.basename(filename).startsWith('.backup-')) {
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => {
        await realWrite(bytes.subarray(0, 16));
        throw Object.assign(new Error('backup full disk'), { code: 'ENOSPC' });
      };
    }
    return handle;
  });
  assert.equal((await app.put(first, 1)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.deepEqual(await fs.readdir(path.join(app.directory, 'backups')), []);
  failingOpen.mock.restore();
  assert.equal((await app.put(first, 1)).status, 200);
});

test('Windows 短暂文件占用会重试并成功保存，不丢失记录', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const realRename = fs.rename.bind(fs);
  let attempts = 0;
  const lockedRename = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(app.directory, 'state.json') && attempts++ === 0) {
      throw Object.assign(new Error('temporary Windows lock'), { code: 'EPERM' });
    }
    return realRename(from, to);
  });
  assert.equal((await app.put(first, 1)).status, 200);
  assert.ok(attempts > 1);
  assert.equal((await (await app.get()).json()).revision, 2);
  lockedRename.mock.restore();
});

test('Windows 持续文件占用只做有限重试，明确报错且保留旧版本', { skip: process.platform !== 'win32' }, async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const realRename = fs.rename.bind(fs);
  let attempts = 0;
  const lockedRename = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(app.directory, 'state.json')) {
      attempts++;
      throw Object.assign(new Error('persistent Windows lock'), { code: 'EACCES' });
    }
    return realRename(from, to);
  });
  const started = performance.now();
  assert.equal((await app.put(first, 1)).status, 503);
  assert.ok(attempts > 1 && attempts < 20, '必须重试但不能无限等待');
  assert.ok(performance.now() - started < 4_000, '占用错误必须及时返回');
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.ok(!(await fs.readdir(app.directory)).some(name => name.endsWith('.tmp')));
  lockedRename.mock.restore();
  assert.equal((await app.put(first, 1)).status, 200);
});

test('时钟回拨不删除新备份，且 9 位修订号仍然只保留最近 30 份', async t => {
  const app = await fixture(t);
  const state = emptyState(); state.revision = 100_000_032;
  await fs.writeFile(path.join(app.directory, 'state.json'), JSON.stringify(state));
  const backupDirectory = path.join(app.directory, 'backups');
  await fs.mkdir(backupDirectory);
  for (let index = 0; index < 32; index++) {
    const revision = 100_000_000 + index;
    const prior = { ...emptyState(), revision };
    await fs.writeFile(path.join(backupDirectory, `2099-01-01T00-00-00-000Z-${revision}-${randomUUID()}.json`), JSON.stringify(prior));
  }
  assert.equal((await app.put(state, state.revision)).status, 200);
  const backups = await fs.readdir(backupDirectory);
  assert.equal(backups.length, 30);
  const revisions = [];
  for (const name of backups) revisions.push(JSON.parse(await fs.readFile(path.join(backupDirectory, name), 'utf8')).revision);
  assert.deepEqual(revisions.sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => 100_000_003 + index));
});

test('非法请求版本、状态结构和非 JSON 类型都不改变已保存文件', async t => {
  const app = await fixture(t);
  const first = await (await app.put(emptyState(), 0)).json();
  const originalBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  for (const revision of [null, '1', true, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await app.put(first, revision)).status, 400);
  }
  for (const state of [null, [], {}, { ...first, entries: null }, { ...first, schemaVersion: 2 }]) {
    assert.equal((await app.put(state, 1)).status, 400);
  }
  const wrongType = await rawRequest(app, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ state: first, expectedRevision: 1 }),
  });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), originalBytes);
  assert.equal((await app.put(first, 1)).status, 200);
});

test('服务以 expectedRevision 为并发依据，客户端不能篡改保存修订号', async t => {
  const app = await fixture(t);
  const incoming = emptyState(); incoming.revision = 1234;
  const response = await app.put(incoming, 0);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  assert.equal((await (await app.get()).json()).revision, 1);
});

test('2 MB 字节边界可提交，声明长度和 chunked 超限均拒绝且不覆盖记录', async t => {
  const app = await fixture(t);
  const jsonBody = JSON.stringify({ state: emptyState(), expectedRevision: 0 });
  const exactBoundary = jsonBody + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(jsonBody));
  const exact = await rawRequest(app, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(exactBoundary) },
    body: exactBoundary,
  });
  assert.equal(exact.status, 200);
  const savedBytes = await fs.readFile(path.join(app.directory, 'state.json'));
  const overDeclared = await rawRequest(app, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json', 'Content-Length': 2 * 1024 * 1024 + 1 },
    body: 'x'.repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(overDeclared.status, 413);
  const chunked = await rawRequest(app, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json' },
    chunks: [Buffer.alloc(1024 * 1024, ' '), Buffer.alloc(1024 * 1024, ' '), Buffer.from(' ')],
  });
  assert.equal(chunked.status, 413);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), savedBytes);
});

test('无效 UTF-8 不被默默替换成乱码后保存', async t => {
  const app = await fixture(t);
  const valid = JSON.stringify({ state: emptyState(), expectedRevision: 0 }).replace('"name":""', '"name":"INVALID"');
  const invalidBytes = Buffer.concat([Buffer.from(valid.split('INVALID')[0]), Buffer.from([0xff]), Buffer.from(valid.split('INVALID')[1])]);
  const response = await rawRequest(app, {
    method: 'PUT', headers: { Origin: app.base, 'Content-Type': 'application/json', 'Content-Length': invalidBytes.length }, body: invalidBytes,
  });
  assert.equal(response.status, 400);
  assert.equal((await (await app.get()).json()).revision, 0);
  assert.equal(await fs.stat(path.join(app.directory, 'state.json')).then(() => true, error => error.code !== 'ENOENT'), false);
});

test('有效 JSON 但非法状态、空文件、无效 UTF-8 主文件均保留并报错', async t => {
  const app = await fixture(t);
  const valid = JSON.stringify(emptyState()).replace('"name":""', '"name":"INVALID"');
  const invalidUtf8 = Buffer.concat([Buffer.from(valid.split('INVALID')[0]), Buffer.from([0xff]), Buffer.from(valid.split('INVALID')[1])]);
  for (const corrupt of [Buffer.alloc(0), Buffer.from(JSON.stringify({ ...emptyState(), entries: null })), invalidUtf8]) {
    await fs.writeFile(path.join(app.directory, 'state.json'), corrupt);
    assert.equal((await app.get()).status, 503);
    assert.equal((await app.put(emptyState(), 0)).status, 503);
    assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), corrupt);
  }
});

test('已达到安全整数上限的修订号拒绝继续写入而不损坏文件', async t => {
  const app = await fixture(t);
  const state = { ...emptyState(), revision: Number.MAX_SAFE_INTEGER };
  const original = Buffer.from(JSON.stringify(state));
  await fs.writeFile(path.join(app.directory, 'state.json'), original);
  assert.equal((await app.get()).status, 200);
  assert.equal((await app.put(state, state.revision)).status, 503);
  assert.deepEqual(await fs.readFile(path.join(app.directory, 'state.json')), original);
});

test('请求中途断开不会创建部分记录，也不会阻塞下一次正常保存', async t => {
  const app = await fixture(t);
  await new Promise(resolve => {
    const request = http.request({ hostname: '127.0.0.1', port: app.port, path: '/api/state', method: 'PUT',
      headers: { Origin: app.base, 'Content-Type': 'application/json', 'Content-Length': 1000 } });
    request.on('error', () => {});
    request.on('socket', socket => socket.once('connect', () => {
      request.write('{"expectedRevision":0,"state":');
      setTimeout(() => { request.destroy(); resolve(); }, 20);
    }));
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await (await app.get()).json()).revision, 0);
  assert.equal((await app.put(emptyState(), 0)).status, 200);
});

test('静态资源 MIME、HEAD、SW 和完整路径保护不会暴露数据', async t => {
  const app = await fixture(t);
  const html = await fetch(`${app.base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  const head = await fetch(`${app.base}/index.html?test=1`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('content-length')), (await fs.stat(path.join(appDirectory, 'index.html'))).size);
  const worker = await fetch(`${app.base}/sw.js`);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.match((await fetch(`${app.base}/icons/app.svg`)).headers.get('content-type'), /^image\/svg\+xml/);
  for (const pathname of ['/%ZZ', '/%2e%2e/data/state.json', '/icons/%2e%2e/data/state.json', '/icons%5c..%5cdata%5cstate.json', '/index.html%00']) {
    const response = await rawRequest(app, { pathname });
    assert.ok([400, 403].includes(response.status), pathname);
  }
  for (const pathname of ['/icons/data.json', '/output/test.html', '/data%2fstate.json']) {
    assert.equal((await rawRequest(app, { pathname })).status, 404, pathname);
  }
  assert.equal((await rawRequest(app, { method: 'DELETE', headers: { Origin: app.base } })).status, 405);
});

test('localhost 同源允许，协议不同、端口不同和 Host 与 Origin 不匹配均拒绝', async t => {
  const app = await fixture(t);
  const legitimate = await rawRequest(app, {
    method: 'PUT', headers: { Host: `localhost:${app.port}`, Origin: `http://localhost:${app.port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: emptyState(), expectedRevision: 0 }),
  });
  assert.equal(legitimate.status, 200);
  for (const origin of [`https://127.0.0.1:${app.port}`, `http://127.0.0.1:${app.port + 1}`, `http://localhost:${app.port}`]) {
    assert.equal((await app.get({ Origin: origin })).status, 403);
  }
  assert.equal((await app.get()).headers.get('access-control-allow-origin'), null);
});

test('真实 Node 进程在保存确认后被终止并重启，记录及备份仍可恢复', async t => {
  const app = await processFixture(t);
  const firstState = emptyState(); firstState.profile.name = 'first';
  const firstResponse = await app.put(firstState, 0);
  assert.equal(firstResponse.status, 200);
  const first = JSON.parse(firstResponse.body);
  const nextState = { ...first, profile: { ...first.profile, name: 'second' } };
  const secondResponse = await app.put(nextState, 1);
  assert.equal(secondResponse.status, 200);
  const second = JSON.parse(secondResponse.body);
  assert.equal(second.revision, 2);
  await app.stop();
  await app.start();
  const restartedResponse = await app.get();
  assert.equal(restartedResponse.status, 200);
  assert.deepEqual(JSON.parse(restartedResponse.body), second);
  await app.stop();
  const [backup] = await fs.readdir(path.join(app.directory, 'backups'));
  const backupBytes = await fs.readFile(path.join(app.directory, 'backups', backup));
  assert.deepEqual(JSON.parse(backupBytes), first);
  await fs.writeFile(path.join(app.directory, 'state.json'), '{damaged');
  await app.start();
  assert.equal((await app.get()).status, 503);
  await app.stop();
  await fs.copyFile(path.join(app.directory, 'backups', backup), path.join(app.directory, 'state.json'));
  await app.start();
  const recoveredResponse = await app.get();
  assert.equal(recoveredResponse.status, 200);
  assert.deepEqual(JSON.parse(recoveredResponse.body), first);
  assert.equal((await app.put(first, 1)).status, 200);
  assert.equal(JSON.parse((await app.get()).body).revision, 2);
});

test('CLI 拒绝无效端口及已占用测试端口，不修改磁盘记录', async t => {
  const app = await fixture(t);
  const invalid = await runProcess(process.execPath, [path.join(appDirectory, 'server.js')], {
    cwd: appDirectory, env: { ...process.env, HEADACHE_PORT: '0', HEADACHE_DATA_DIR: app.directory },
  });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /HEADACHE_PORT must be/);
  const occupied = await runProcess(process.execPath, [path.join(appDirectory, 'server.js')], {
    cwd: appDirectory, env: { ...process.env, HEADACHE_PORT: String(app.port), HEADACHE_DATA_DIR: app.directory },
  });
  assert.notEqual(occupied.code, 0);
  assert.match(occupied.stderr, /EADDRINUSE/);
  assert.equal((await (await app.get()).json()).revision, 0);
  assert.deepEqual(await fs.readdir(app.directory), []);
});

test('Windows 桌面启动链在独立端口冷启动并复用服务，可测启动耗时', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-diary-test-'));
  const isolatedApp = path.join(directory, '中文 路径');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  let ownedNodePid;
  let wrongService;
  t.after(async () => {
    if (ownedNodePid) { try { process.kill(ownedNodePid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (wrongService?.listening) await new Promise(resolve => wrongService.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 100));
    await removeTestDirectory(directory);
  });
  await fs.mkdir(isolatedApp);
  for (const file of ['server.js', 'model.js']) await fs.copyFile(path.join(appDirectory, file), path.join(isolatedApp, file));
  const support = (await fs.readFile(path.join(appDirectory, 'installer', 'runtime-support.ps1'), 'utf8')).replaceAll('17843', String(port));
  await fs.writeFile(path.join(isolatedApp, 'runtime-support.ps1'), support);
  await fs.writeFile(path.join(isolatedApp, 'package.json'), JSON.stringify({ type: 'module' }));
  const launcher = (await fs.readFile(path.join(appDirectory, 'launch.ps1'), 'utf8'))
    .replaceAll('17843', String(port)).replaceAll('HeadacheDiaryDesktopLaunch', `HeadacheDiaryTest-${randomUUID()}`);
  const launcherPath = path.join(isolatedApp, 'launch.ps1');
  await fs.writeFile(launcherPath, launcher);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const arguments_ = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-NoBrowser'];
  const cold = await runProcess(powershell, arguments_, { cwd: isolatedApp });
  assert.equal(cold.code, 0, cold.stderr);
  assert.ok(cold.stdout.includes(base), '启动结果必须报告正确测试地址');
  const firstLog = await fs.readFile(path.join(isolatedApp, 'data', 'server.log'), 'utf8');
  const pidMatch = /\(pid=(\d+)\)/.exec(firstLog);
  assert.ok(pidMatch, '必须可识别本测试启动的独立进程');
  ownedNodePid = Number(pidMatch[1]);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'headache-diary', version: 1 });
  const warmTimes = [];
  for (let index = 0; index < 3; index++) {
    const warm = await runProcess(powershell, arguments_, { cwd: isolatedApp });
    assert.equal(warm.code, 0, warm.stderr);
    warmTimes.push(warm.milliseconds);
  }
  assert.equal(await fs.readFile(path.join(isolatedApp, 'data', 'server.log'), 'utf8'), firstLog, '复用时不得重启服务或覆盖日志');
  assert.equal((await fs.stat(path.join(isolatedApp, 'data', 'server.error.log'))).size, 0);
  assert.equal(await fs.stat(path.join(isolatedApp, 'data', 'state.json')).then(() => true, error => error.code !== 'ENOENT'), false);
  t.diagnostic(`启动到本机服务就绪：冷启动 ${Math.round(cold.milliseconds)} ms；3 次热启动 ${warmTimes.map(value => Math.round(value)).join(', ')} ms。未打开浏览器。`);
  process.kill(ownedNodePid);
  ownedNodePid = null;
  await new Promise(resolve => setTimeout(resolve, 100));
  wrongService = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ app: 'another-app', version: 1 }));
  });
  await new Promise((resolve, reject) => { wrongService.once('error', reject); wrongService.listen(port, '127.0.0.1', resolve); });
  const conflicting = await runProcess(powershell, arguments_, { cwd: isolatedApp });
  assert.notEqual(conflicting.code, 0, '其他程序占用端口时不得误认为日记服务');
  assert.ok(conflicting.stderr.includes(String(port)), '必须说明被占用的测试端口');
  assert.equal(await fs.readFile(path.join(isolatedApp, 'data', 'server.log'), 'utf8'), firstLog);
});

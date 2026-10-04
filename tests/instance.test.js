import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createAppServer } from '../server.js';

async function start(t, installMode = 'application-directory') {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headache-instance-'));
  const server = createAppServer({ port, dataDirectory: directory, installMode });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeIdleConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { server, directory, port, base: `http://127.0.0.1:${port}` };
}

test('安装实例返回可核验目录、PID和模式；健康接口保持兼容', async t => {
  const app = await start(t, 'per-user');
  const response = await fetch(`${app.base}/api/instance`);
  const value = await response.json();
  assert.equal(value.app, 'headache-diary');
  assert.equal(value.version, 1);
  assert.equal(value.pid, process.pid);
  assert.equal(value.port, app.port);
  assert.equal(value.installMode, 'per-user');
  assert.equal(value.dataDirectory, app.directory);
  assert.ok(path.isAbsolute(value.appRoot));
  assert.deepEqual(await (await fetch(`${app.base}/api/health`)).json(), { app: 'headache-diary', version: 1 });
  assert.equal((await fetch(`${app.base}/api/instance`, { headers: { Origin: 'https://example.com' } })).status, 403);
});

test('开发实例拒绝安装程序关闭请求', async t => {
  const app = await start(t);
  const response = await fetch(`${app.base}/api/shutdown`, { method: 'POST', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${app.base}/api/state`)).status, 200);
});

test('安装实例仅同源POST可以进入关闭状态', async t => {
  const app = await start(t, 'per-user');
  for (const headers of [{}, { Origin: 'https://example.com' }]) {
    assert.equal((await fetch(`${app.base}/api/shutdown`, { method: 'POST', headers })).status, 403);
  }
  assert.equal((await fetch(`${app.base}/api/shutdown`)).status, 405);
  const event = once(app.server, 'managed-shutdown');
  const response = await fetch(`${app.base}/api/shutdown`, { method: 'POST', headers: { Origin: app.base } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopping: true, pid: process.pid });
  await event;
  assert.equal((await fetch(`${app.base}/api/state`)).status, 503);
  assert.equal((await fetch(`${app.base}/api/instance`)).status, 200);
});

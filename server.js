import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { emptyState, validateState } from './model.js';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const maximumBodyBytes = 2 * 1024 * 1024;
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const staticFiles = new Set(['index.html', 'app.js', 'styles.css', 'model.js', 'reports.js', 'charts.js', 'manifest.webmanifest', 'sw.js']);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    throw new RequestError(415, '请使用 JSON 格式提交记录。');
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    request.resume();
    throw new RequestError(413, '记录文件超过 2 MB，请缩小导入文件。');
  }
  const chunks = [];
  let length = 0;
  await new Promise((resolve, reject) => {
    request.on('data', chunk => {
      length += chunk.length;
      if (length > maximumBodyBytes) {
        chunks.length = 0;
        reject(new RequestError(413, '记录文件超过 2 MB，请缩小导入文件。'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', resolve);
    request.on('error', reject);
    request.on('aborted', () => reject(new RequestError(400, '提交中断，记录尚未保存。')));
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RequestError(400, '提交的 JSON 无法读取，记录尚未保存。'); }
}

function validateStoredState(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0) {
    throw new Error('Invalid stored revision');
  }
  return { ...validateState(value), revision: value.revision };
}

async function loadState(directory) {
  let bytes;
  try { bytes = await fs.readFile(path.join(directory, 'state.json')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      const backupNames = await fs.readdir(path.join(directory, 'backups')).catch(backupError => {
        if (backupError.code === 'ENOENT') return [];
        throw new RequestError(503, '无法检查本机备份文件。请检查文件权限后重试。');
      });
      if (backupNames.some(name => name.endsWith('.json'))) {
        throw new RequestError(503, '主记录文件缺失，但本机仍有备份，未自动清空。请先复制 data 文件夹，再从 data/backups 中恢复最近的完好备份。');
      }
      return { state: { ...emptyState(), revision: 0 }, bytes: null };
    }
    throw new RequestError(503, '无法读取本机记录文件。请检查文件权限和磁盘空间后重试。');
  }
  try { return { state: validateStoredState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), bytes }; }
  catch {
    throw new RequestError(503, '本机记录文件损坏，原文件已保留，未自动清空。请先复制 data 文件夹，再从 data/backups 中恢复最近的完好备份。');
  }
}

async function writeAtomically(filename, bytes, prefix) {
  const temporary = path.join(path.dirname(filename), `.${prefix}-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    const retryDelays = process.platform === 'win32' ? [20, 50, 100, 150, 200] : [];
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, filename); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retryDelays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function backupRevision(filename) {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(\d{8,16})-[a-f\d-]{36}\.json$/.exec(filename);
  return match ? Number(match[1]) : null;
}

async function atomicSave(directory, state, previousBytes) {
  const primary = path.join(directory, 'state.json');
  try {
    await fs.mkdir(directory, { recursive: true });
    if (previousBytes) {
      const backupDirectory = path.join(directory, 'backups');
      await fs.mkdir(backupDirectory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `${stamp}-${String(state.revision - 1).padStart(8, '0')}-${randomUUID()}.json`;
      await writeAtomically(path.join(backupDirectory, backupName), previousBytes, 'backup');
      // Revision order remains correct if the computer's clock moves backwards.
      const backups = (await fs.readdir(backupDirectory)).filter(name => backupRevision(name) !== null)
        .sort((a, b) => backupRevision(a) - backupRevision(b) || a.localeCompare(b));
      for (const stale of backups.slice(0, Math.max(0, backups.length - 30))) {
        await fs.unlink(path.join(backupDirectory, stale));
      }
    }
    await writeAtomically(primary, `${JSON.stringify(state, null, 2)}\n`, 'state');
  } catch (error) {
    console.error('Storage write failed:', error.code || error.message);
    throw new RequestError(503, '记录尚未保存到磁盘。请检查文件权限和磁盘空间，再点击重试。');
  }
}

function protectRequest(request, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(request.headers.host)) throw new RequestError(403, '访问地址不被允许。请从桌面图标打开。');
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::ffff:127.0.0.1') throw new RequestError(403, '仅允许本机访问。');
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) throw new RequestError(403, '其他网页无法访问或修改您的记录。');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '其他网页无法访问或修改您的记录。');
  if (request.method === 'PUT' && !origin) throw new RequestError(403, '缺少同源验证，记录尚未保存。');
}

function requestedFile(rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent((rawUrl || '/').split('?')[0]); }
  catch { throw new RequestError(400, '地址无法读取。'); }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
    throw new RequestError(403, '不允许访问此文件。');
  }
  return pathname;
}

export function createAppServer({ port = 17843, dataDirectory = path.join(appDirectory, 'data'), installMode = 'application-directory' } = {}) {
  dataDirectory = path.resolve(dataDirectory);
  let stopping = false;
  let storageQueue = Promise.resolve();
  const enqueueStorage = operation => {
    const pending = storageQueue.then(operation);
    storageQueue = pending.catch(() => {});
    return pending;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      protectRequest(request, port);
      const pathname = requestedFile(request.url);
      if (pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, { app: 'headache-diary', version: 1 });
      }
      if (pathname === '/api/instance' && request.method === 'GET') {
        return json(response, 200, { app: 'headache-diary', version: 1, appRoot: appDirectory,
          dataDirectory, port, pid: process.pid, installMode });
      }
      if (pathname === '/api/shutdown' && request.method === 'POST') {
        if (installMode !== 'per-user') throw new RequestError(403, '此安装操作不能停止开发版服务。');
        if (request.headers.origin !== `http://${request.headers.host}`) throw new RequestError(403, '缺少同源验证。');
        request.resume();
        stopping = true;
        await storageQueue;
        response.once('finish', () => server.emit('managed-shutdown'));
        return json(response, 200, { stopping: true, pid: process.pid });
      }
      if (stopping && pathname.startsWith('/api/')) throw new RequestError(503, '正在更新或卸载，请稍后从桌面图标重新打开。');
      if (pathname === '/api/state' && request.method === 'GET') {
        const { state } = await enqueueStorage(() => loadState(dataDirectory));
        return json(response, 200, state);
      }
      if (pathname === '/api/state' && request.method === 'PUT') {
        const body = await readBody(request);
        if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0) {
          throw new RequestError(400, '保存版本无效，请重新打开记录后重试。');
        }
        let incoming;
        try { incoming = validateState(body.state); }
        catch (error) { throw new RequestError(400, error.message || '记录格式无效，尚未保存。'); }
        const saved = await enqueueStorage(async () => {
          const { state: current, bytes } = await loadState(dataDirectory);
          if (current.revision !== body.expectedRevision) {
            throw new RequestError(409, '另一窗口已更新记录。请重新加载后再保存，避免覆盖。');
          }
          if (current.revision === Number.MAX_SAFE_INTEGER) {
            throw new RequestError(503, '保存版本达到上限，请先导出备份，再联系维护人员。');
          }
          const next = { ...incoming, revision: current.revision + 1 };
          await atomicSave(dataDirectory, next, bytes);
          return next;
        });
        return json(response, 200, saved);
      }
      if (pathname.startsWith('/api/')) throw new RequestError(405, '此请求方式不被支持。');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, '此请求方式不被支持。');
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const iconAllowed = /^icons\/[a-zA-Z0-9_-]+\.(?:svg|png|ico)$/.test(relative);
      if (!staticFiles.has(relative) && !iconAllowed) throw new RequestError(404, '找不到此页面。');
      let bytes;
      try { bytes = await fs.readFile(path.join(appDirectory, relative)); }
      catch (error) { if (error.code === 'ENOENT') throw new RequestError(404, '找不到此文件。'); throw error; }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(relative)] || 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': relative.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache',
        ...(relative === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : '本机服务发生错误，记录尚未保存，请重试。' });
      else response.end();
      if (!error.status) console.error('Request failed:', error.code || error.message);
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.HEADACHE_PORT || 17843);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HEADACHE_PORT must be between 1024 and 65535');
  const dataDirectory = path.resolve(process.env.HEADACHE_DATA_DIR || path.join(appDirectory, 'data'));
  const installMode = process.env.HEADACHE_INSTALL_MODE === 'per-user' ? 'per-user' : 'application-directory';
  const server = createAppServer({ port, dataDirectory, installMode });
  server.on('managed-shutdown', () => server.close(() => process.exit(0)));
  server.on('error', error => { console.error('Headache Diary startup failed:', error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Headache Diary ready at http://127.0.0.1:${port}/ (pid=${process.pid})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

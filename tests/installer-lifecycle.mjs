// Explicit acceptance run against the built installer. Uses synthetic records only.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { dayKey } from '../model.js';

if (process.platform !== 'win32') throw Error('Windows acceptance run required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const installer = path.join(root, 'dist', `HeadacheDiary-Setup-${version}-x64.exe`);
const evidenceRoot = path.join(root, 'output', 'installer-tests', randomUUID());
const installedRoot = path.join(evidenceRoot, '中文 安装目录');
const profileRoot = path.join(evidenceRoot, '独立 测试账户');
const dataRoot = path.join(profileRoot, 'HeadacheDiary', 'data');
const base = 'http://127.0.0.1:17844';
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wscript = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
const env = { ...process.env, LOCALAPPDATA: profileRoot, PATH: path.join(process.env.SystemRoot, 'System32') };
const milestones = [];
let browser, installed = false, passed = false;

function run(exe, args = [], timeout = 60000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => reject(Error(`Timed out: ${path.basename(exe)}`)), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr, milliseconds: performance.now() - started }); });
  });
}
function note(label, detail = {}) { milestones.push({ label, ...detail }); console.log(JSON.stringify(milestones.at(-1))); }
const hashFile = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
async function waitFor(check, message, duration = 20000) {
  const deadline = performance.now() + duration;
  do { try { const value = await check(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
  throw Error(message);
}
async function identity() { const response = await fetch(`${base}/api/instance`, { signal: AbortSignal.timeout(1000) }); if (!response.ok) throw Error('Instance not ready'); return response.json(); }
const ps = args => run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args]);
async function uninstall() {
  // Inno can choose unins001 after reinstall while the previous uninstaller finishes cleanup.
  const registration=await ps(['-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $taskRegistration=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C8AC86D2-70DB-4BE7-94AD-D23434F3A0D9}_is1'; @{ location=$taskRegistration.InstallLocation; command=$taskRegistration.UninstallString } | ConvertTo-Json -Compress"]);
  assert.equal(registration.code,0,registration.stderr);
  const registered=JSON.parse(registration.stdout.trim());
  assert.equal(path.resolve(registered.location).toLowerCase(),installedRoot.toLowerCase());
  const executable=/^"([^"]+)"(?:\s|$)/.exec(registered.command)?.[1];
  assert.ok(executable,'Expected a quoted registered uninstaller path');
  assert.equal(path.dirname(path.resolve(executable)).toLowerCase(),installedRoot.toLowerCase());
  assert.match(path.basename(executable),/^unins\d{3}\.exe$/i);
  return run(executable, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(evidenceRoot, 'uninstall.log')}`]);
}
async function install(logName) {
  const result = await run(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', `/DIR=${installedRoot}`, `/LOG=${path.join(evidenceRoot, logName)}`]);
  assert.equal(result.code, 0, JSON.stringify(result)); installed = true; return result;
}
async function openInstalled() {
  const started = performance.now();
  const result = await run(wscript, [path.join(installedRoot, 'launch.vbs'), '/NoBrowser']);
  assert.equal(result.code, 0, result.stderr);
  const value = await waitFor(identity, 'Installed desktop launch did not become ready');
  assert.equal(value.app, 'headache-diary');
  assert.equal(value.installMode, 'per-user');
  assert.equal(path.resolve(value.appRoot).toLowerCase(), installedRoot.toLowerCase());
  assert.equal(path.resolve(value.dataDirectory).toLowerCase(), dataRoot.toLowerCase());
  return { ...value, readyMs: Math.round(performance.now() - started) };
}
async function verifyPayload() {
  const manifest = JSON.parse(await fs.readFile(path.join(installedRoot, 'payload-manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.ok(manifest.files.some(item => item.path === 'charts.js'), 'Offline charts must be installed');
  for (const item of manifest.files) {
    assert.equal(await hashFile(path.join(installedRoot, item.path)), item.sha256, item.path);
    assert.ok(!/(^|\/)(data|node_modules|tests|\.git)(\/|$)/.test(item.path));
  }
  const meta = JSON.parse(await fs.readFile(path.join(installedRoot, 'build-meta.json'), 'utf8'));
  assert.equal(meta.runtime.version, 'v24.19.0');
  return manifest.files.length;
}

await fs.mkdir(evidenceRoot, { recursive: true });
const originalState = await hashFile(path.join(root, 'data', 'state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
const originalDesktop = await hashFile(path.join(process.env.USERPROFILE, 'Desktop', '头痛记录.lnk')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
const developerIdentity = await fetch('http://127.0.0.1:17843/api/health').then(response => response.json()).catch(() => null);
const registration = await ps(['-Command', "if (Test-Path -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C8AC86D2-70DB-4BE7-94AD-D23434F3A0D9}_is1') { exit 9 }"]);
assert.equal(registration.code, 0, 'An existing user installation is registered; refusing to overwrite it during testing');
try { await identity(); throw Error('Installed port already occupied; refusing acceptance run'); } catch (error) { if (error.message?.startsWith('Installed port')) throw error; }
try {
  const first = await install('fresh-install.log');
  note('fresh-install', { exitCode: first.code, milliseconds: Math.round(first.milliseconds), verifiedPayloadFiles: await verifyPayload() });
  const node = await run(path.join(installedRoot, 'runtime', 'node.exe'), ['--version']);
  assert.equal(node.stdout.trim(), 'v24.19.0');
  const firstInstance = await openInstalled();
  const warm = await ps(['-File', path.join(installedRoot, 'launch.ps1'), '-NoBrowser']);
  assert.equal(warm.code, 0, warm.stderr);
  assert.equal((await identity()).pid, firstInstance.pid);
  note('bundled-runtime-and-desktop-launch', { version: node.stdout.trim(), coldReadyMs: firstInstance.readyMs, warmReadyMs: Math.round(warm.milliseconds), pid: firstInstance.pid });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(base);
  await page.getByTestId('record-headache').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.equal(await page.getByTestId('start-headache').count(), 0);
  assert.equal(await page.getByTestId('end-headache').count(), 0);
  const clickAt = performance.now();
  await page.getByTestId('record-headache').click();
  await page.getByRole('heading', { name: '这次头痛已记录' }).waitFor();
  const recordMs = Math.round(performance.now() - clickAt);
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.ok(recordMs < 1500);
  const state = await (await fetch(base+'/api/state')).json();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].onsetPrecision, 'day');
  assert.equal(state.entries[0].statusUnknown, true);
  assert.equal(state.entries[0].end, null);
  assert.equal(state.entries[0].pain, null);
  await page.screenshot({ path: path.join(evidenceRoot, 'installed-dark.png'), fullPage: true });
  await page.reload();
  await page.getByTestId('record-headache').waitFor();
  assert.equal((await (await fetch(base+'/api/state')).json()).entries.length, 1);
  assert.equal(await page.getByTestId('end-headache').count(), 0);
  // Separate synthetic fixture edit exercises backup preservation; it is not a required recording step.
  state.profile.name='synthetic installer acceptance';
  const fixtureWrite=await fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:state.revision,state})});
  assert.equal(fixtureWrite.status,200);
  await page.reload();
  await page.getByTestId('record-headache').waitFor();
  await page.getByRole('button', { name: '数据', exact: true }).click();
  await page.getByText('本机数据：%LOCALAPPDATA%', { exact: false }).waitFor();
  const backupEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载备份', exact: false }).click();
  const backup = await backupEvent;
  await backup.saveAs(path.join(evidenceRoot, 'synthetic-backup.json'));
  const backupState = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'synthetic-backup.json'), 'utf8'));
  assert.equal(backupState.entries[0].id, state.entries[0].id);
  assert.equal(backupState.profile.name, state.profile.name);
  await page.getByRole('button', { name: '报告', exact: true }).click();
  const installedDaily = page.getByTestId('daily-headache-chart');
  const installedMonthly = page.getByTestId('monthly-headache-chart');
  await installedDaily.waitFor(); await installedMonthly.waitFor();
  const recordedDate = dayKey(state.entries[0].start);
  assert.equal(await installedDaily.locator(`[data-date="${recordedDate}"]`).getAttribute('data-record-count'), '1');
  assert.equal(await installedMonthly.locator(`[data-month="${recordedDate.slice(0, 7)}"]`).getAttribute('data-record-count'), '1');
  await page.screenshot({ path: path.join(evidenceRoot, 'installed-report-charts.png'), fullPage: true });
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV 明细', exact: false }).click();
  const csv = await csvEvent; await csv.saveAs(path.join(evidenceRoot, 'synthetic-records.csv'));
  await page.getByRole('button', { name: '预览就诊报告', exact: false }).click();
  await page.frameLocator('#report-frame').getByRole('heading', { name: '完整发作明细', exact: true }).waitFor();
  const htmlEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 HTML 报告', exact: true }).click();
  const htmlDownload = await htmlEvent;
  await htmlDownload.saveAs(path.join(evidenceRoot, 'synthetic-report.html'));
  const reportHtml = await fs.readFile(path.join(evidenceRoot, 'synthetic-report.html'), 'utf8');
  assert.ok(reportHtml.includes('data-testid="daily-headache-chart"'));
  assert.ok(reportHtml.includes('data-testid="monthly-headache-chart"'));
  assert.ok(!/<script\b/i.test(reportHtml));
  const pdfPage = await context.newPage(); await pdfPage.setContent(reportHtml);
  await pdfPage.pdf({ path: path.join(evidenceRoot, 'synthetic-report.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await context.close(); await browser.close(); browser = null;
  const savedHash = await hashFile(path.join(dataRoot, 'state.json'));
  const backupFiles = await fs.readdir(path.join(dataRoot, 'backups'));
  assert.ok(backupFiles.length >= 1);
  note('patient-one-click-and-exports', { clicksPerHeadache: 1, requiresEndingStep: false, recordMs, dark: true, chartCountsVerified: true, exports: ['JSON', 'CSV', 'HTML', 'A4 PDF'], backupCount: backupFiles.length });

  const upgrade = await install('upgrade-install.log');
  assert.equal(await hashFile(path.join(dataRoot, 'state.json')), savedHash);
  await waitFor(async () => { try { await identity(); return false; } catch { return true; } }, 'Old service survived upgrade');
  await verifyPayload();
  const registrationCount = await ps(['-Command', "@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Where-Object PSChildName -eq '{C8AC86D2-70DB-4BE7-94AD-D23434F3A0D9}_is1').Count"]);
  assert.equal(registrationCount.stdout.trim(), '1');
  const upgradedInstance = await openInstalled();
  assert.notEqual(upgradedInstance.pid, firstInstance.pid);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).entries[0].id, state.entries[0].id);
  note('upgrade-retains-data', { exitCode: upgrade.code, originalPid: firstInstance.pid, newPid: upgradedInstance.pid, stateSha256: savedHash });

  const removed = await uninstall();
  assert.equal(removed.code, 0, JSON.stringify(removed)); installed = false;
  assert.equal(await fs.stat(path.join(installedRoot, 'server.js')).then(() => true, error => error.code !== 'ENOENT'), false);
  assert.equal(await hashFile(path.join(dataRoot, 'state.json')), savedHash);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'backups')), backupFiles);
  await waitFor(async () => { try { await identity(); return false; } catch { return true; } }, 'Service survived uninstall');
  note('uninstall-retains-records-and-backups', { exitCode: removed.code, stateSha256: savedHash });

  await install('reinstall.log'); await openInstalled();
  assert.equal((await (await fetch(`${base}/api/state`)).json()).entries[0].id, state.entries[0].id);
  assert.equal(await hashFile(path.join(dataRoot, 'state.json')), savedHash);
  note('reinstall-restores-existing-diary');
  passed = true;
} finally {
  if (browser) await browser.close();
  if (installed) {
    const result = await uninstall();
    assert.equal(result.code, 0, `Acceptance cleanup uninstall failed: ${result.stderr}`);
  }
  const finalRegistration = await ps(['-Command', "if (Test-Path -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C8AC86D2-70DB-4BE7-94AD-D23434F3A0D9}_is1') { exit 9 }"]);
  assert.equal(finalRegistration.code, 0, 'Acceptance uninstall registration must be removed');
  const finalState = await hashFile(path.join(root, 'data', 'state.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.equal(finalState, originalState, 'Developer patient data must stay unchanged');
  const finalDesktop = await hashFile(path.join(process.env.USERPROFILE, 'Desktop', '头痛记录.lnk')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.equal(finalDesktop, originalDesktop, 'Existing desktop shortcut must stay unchanged');
  if (developerIdentity) assert.deepEqual(await (await fetch('http://127.0.0.1:17843/api/health')).json(), developerIdentity);
  await fs.writeFile(path.join(evidenceRoot, 'acceptance.json'), JSON.stringify({ passed, installer, installerSha256: await hashFile(installer), version, milestones, developerDataUnchanged: true, existingShortcutUnchanged: true }, null, 2));
  console.log(`Evidence: ${evidenceRoot}`);
}

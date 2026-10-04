import { test as base, expect } from '@playwright/test';
import { createAppServer } from '../../server.js';
import { emptyState } from '../../model.js';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const test = base.extend({
  diary: async ({}, use, testInfo) => {
    const directory = testInfo.outputPath('diary');
    await fs.mkdir(directory, { recursive: true });
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    let server, running = false;
    const start = async () => {
      server = createAppServer({ port, dataDirectory: directory });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      running = true;
    };
    const stop = async () => { if (!running) return; running = false; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    const url = `http://127.0.0.1:${port}`;
    const state = async () => {
      const response = await fetch(`${url}/api/state`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const seed = async data => {
      const current = await state();
      const response = await fetch(`${url}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ expectedRevision: current.revision, state: data }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    await start();
    const diskState = async () => JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    await use({ url, directory, state, diskState, seed, start, stop });
    await stop();
  },
  patient: async ({ page, diary }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(diary.url);
    await expect(page.getByTestId('record-headache')).toBeVisible();
    await installTiming(page);
    await use(page);
    expect(errors, 'patient page has no uncaught JavaScript errors').toEqual([]);
  },
});
export { expect, emptyState };
export const localValue = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
export const nav = (page, label) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: label, exact: true }).click();
export async function installTiming(page) {
  await page.evaluate(() => {
    if (window.__qaTimingInstalled) return;
    window.__qaTimingInstalled = true;
    document.addEventListener('click',event=>{
      const action=event.target.closest('[data-action]')?.dataset.action;
      if(action==='record') window.__qaTiming={action,click:performance.now(),clickWallTime:Date.now(),putConfirmedAt:null,confirmedMs:null};
    },true);
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...arguments_) => {
      const started = performance.now();
      const response = await originalFetch(...arguments_);
      const timing = window.__qaTiming;
      const url = arguments_[0] instanceof Request ? arguments_[0].url : String(arguments_[0]);
      const method = arguments_[1]?.method || (arguments_[0] instanceof Request ? arguments_[0].method : 'GET');
      if(timing && started>=timing.click && method==='PUT' && url.endsWith('/api/state') && response.ok) timing.putConfirmedAt=performance.now();
      return response;
    };
    new MutationObserver(()=>{
      const timing=window.__qaTiming;
      const complete=[...document.querySelectorAll('h1,h2')].some(el=>el.textContent==='这次头痛已记录');
      if(timing && timing.putConfirmedAt!==null && complete && timing.confirmedMs===null && document.querySelector('#save-status')?.textContent==='已保存')timing.confirmedMs=performance.now()-timing.click;
    }).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  });
}
export async function confirmedTiming(page) {
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect.poll(()=>page.evaluate(()=>window.__qaTiming?.confirmedMs)).not.toBeNull();
  return page.evaluate(()=>window.__qaTiming);
}
export async function recordOnce(page, diary) {
  const before = await diary.state();
  const ids = new Set(before.entries.map(entry=>entry.id));
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('heading', { name: '这次头痛已记录', exact: true })).toBeVisible();
  await expect.poll(async ()=>(await diary.state()).entries.length).toBe(before.entries.length+1);
  await expect(page.locator('#save-status')).toHaveText('已保存');
  return (await diary.state()).entries.find(entry=>!ids.has(entry.id));
}

export async function seedExact(diary, fields={}) {
  const stamp=new Date().toISOString();
  const data=emptyState();
  const entry={id:'legacy-exact',start:new Date(Date.now()-7200000).toISOString(),end:new Date(Date.now()-3600000).toISOString(),endUnknown:false,statusUnknown:false,onsetPrecision:'exact',pain:null,symptoms:null,locations:null,character:null,triggers:null,impact:null,menstruation:null,notes:'',medications:[],createdAt:stamp,updatedAt:stamp,...fields};
  data.entries.push(entry);
  return (await diary.seed(data)).entries[0];
}

// Synthetic historical data: three December 31 records, one continuing into
// January, plus date-only January/February records and a confirmed pain-free day.
// Keep the rows out of chronological order so charts must sort the calendar.
export function reportChartCase() {
  const stamp = new Date().toISOString();
  const iso = value => new Date(`${value}+08:00`).toISOString();
  const entry = (id, start, end, fields = {}) => ({
    id, start: iso(start), end: end === null ? null : iso(end),
    endUnknown: end === null, onsetPrecision: end === null ? 'day' : 'exact',
    pain: null, symptoms: null, locations: null, character: null,
    triggers: null, impact: null, menstruation: null, notes: '', medications: [],
    createdAt: stamp, updatedAt: stamp, ...fields,
  });
  const data = emptyState();
  data.entries = [
    entry('chart-feb-date', '2024-02-01T00:00:00', null,
      { statusUnknown: true, notes: '合成病例：二月仅日期' }),
    entry('chart-cross-year', '2023-12-31T23:00:00', '2024-01-01T02:00:00',
      { pain: 7, notes: '合成病例：跨年延续', medications: [
        { id: 'chart-dose-1', name: '验收用药名', dose: '', at: iso('2024-01-01T00:30:00'), relief: null },
        { id: 'chart-dose-2', name: '验收用药名', dose: '', at: iso('2024-01-01T01:30:00'), relief: null },
      ] }),
    entry('chart-dec-morning', '2023-12-31T09:00:00', '2023-12-31T10:00:00',
      { pain: 3, notes: '合成病例：十二月早间' }),
    entry('chart-jan-date', '2024-01-02T00:00:00', null,
      { statusUnknown: true, notes: '合成病例：一月仅日期' }),
    entry('chart-dec-afternoon', '2023-12-31T15:00:00', '2023-12-31T16:00:00',
      { pain: 5, notes: '合成病例：十二月午后' }),
  ];
  data.days = [{ date: '2024-01-03', status: 'no-headache' }];
  return {
    data, from: '2023-12-30', to: '2024-02-02',
    months: ['2023-12', '2024-01', '2024-02'],
    countByMonth: [3, 1, 1],
    // 35 selected days = 4 headache days + 1 confirmed pain-free day + 30 unknown.
    expected: { totalDays: 35, headacheDays: 4, noHeadacheDays: 1, unknownDays: 30 },
  };
}

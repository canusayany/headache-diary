import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reportHTML, recordsCSV, backupJSON } from '../reports.js';

const at = (day, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const now = new Date(2026, 9, 4, 18);
const entry = (overrides = {}) => ({
  id: 'episode-a', start: at(2, 12), end: at(2, 14), endUnknown: false,
  onsetPrecision: 'exact', pain: 7, symptoms: null, locations: null, character: null,
  triggers: null, impact: null, menstruation: null, notes: '', medications: [],
  createdAt: at(2, 12), updatedAt: at(2, 14), ...overrides,
});
const state = (entries = [], profile = {}) => ({
  schemaVersion: 1, revision: 0, profile: { name: '', theme: 'light', medications: [], ...profile },
  entries, days: [],
});

const local = (year, month, day, hour = 12, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).toISOString();
const decodeHTML = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Read table data as a reviewer would see it, independently of the data model.
function tableRows(html, firstHeader, secondHeader = null) {
  for (const match of html.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const headers = [...match[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(cell => decodeHTML(cell[1]));
    if (headers[0] !== firstHeader || (secondHeader && headers[1] !== secondHeader)) continue;
    const tbody = match[1].match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row =>
      [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => decodeHTML(cell[1])));
  }
  assert.fail(`Missing report table: ${firstHeader}`);
}

function metricRows(html) {
  return Object.fromEntries(tableRows(html, '指标').map(([name, value]) => [name, value]));
}

function chartData(html, key, value) {
  const elements = [...html.matchAll(/<[^>]+>/g)].map(match => match[0])
    .filter(tag => tag.includes(`${key}="${value}"`) && tag.includes('data-record-count='));
  assert.equal(elements.length, 1, `One chart datum must represent ${key}=${value}`);
  return Object.fromEntries([...elements[0].matchAll(/(data-[a-z-]+)="([^"]*)"/g)]
    .map(match => [match[1], decodeHTML(match[2])]));
}

// A quoted-field CSV reader exercises embedded newlines, commas and doubled quotes.
function csvRows(csv) {
  const source = csv.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (character === '\r' || character === '\n')) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += character;
  }
  assert.equal(quoted, false, 'CSV must not leave an open quoted field');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}

function csvObjects(csv) {
  const [headers, ...rows] = csvRows(csv);
  assert.equal(headers.length, 23);
  return rows.map(row => {
    assert.equal(row.length, headers.length, 'Every export row must retain every column');
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  });
}

test('HTML report escapes all untrusted patient and record text and contains no executable script', () => {
  const attack = entry({
    notes: '<script>alert("private")</script>\n& test',
    symptoms: ['<img src=x onerror=alert(1)>'], triggers: ['"onclick="danger'],
    medications: [{ id: 'dose-a', name: '<svg onload=alert(1)>', dose: '1 & 2', at: at(2), relief: null }],
  });
  const html = reportHTML(state([attack], { name: '<b>Patient</b>' }), '2026-10-01', '2026-10-04', now);
  assert.ok(html.includes('&lt;b&gt;Patient&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;private&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('NICE CG150'));
  assert.ok(html.includes('未记录的日期不能视为无头痛'));
});

test('report distinguishes unknown, ongoing and known durations, with actual sample sizes', () => {
  const attacks = [
    entry(),
    entry({ id: 'unknown-end', start: at(3), end: null, endUnknown: true, pain: null }),
    entry({ id: 'ongoing', start: at(4), end: null, pain: 0 }),
  ];
  const html = reportHTML(state(attacks), '2026-10-01', '2026-10-04', now);
  assert.ok(html.includes('2.0 小时；n = 1'));
  assert.ok(html.includes('3.5 / 10；n = 2'));
  assert.ok(html.includes('已结束，结束时间不详'));
  assert.ok(html.includes('仍在持续，已 6.0 小时'));
  assert.ok(html.includes('0 / 10'));
  assert.ok(!html.includes('姓名：'));
});

test('range includes overlapping episode context and in-range doses from other episodes', () => {
  const spanning = entry({
    id: 'spanning', start: at(1, 23), end: at(2, 2),
    medications: [
      { id: 'outside-context', name: '时段外药', dose: '1 片', at: at(1, 23), relief: 'partial' },
      { id: 'inside', name: '时段内药', dose: '2 片', at: at(2, 1), relief: 'good' },
    ],
  });
  const other = entry({
    id: 'other', start: at(1, 12), end: at(1, 14),
    medications: [{ id: 'later-dose', name: '其他发作用药', dose: '3 ml', at: at(2, 13), relief: 'none' }],
  });
  const html = reportHTML(state([spanning, other]), '2026-10-02', '2026-10-02', now);
  assert.ok(html.includes('3.0 小时；n = 1'));
  assert.ok(html.includes('时段外 · 仅供发作上下文'));
  assert.ok(html.includes('其他发作用药'));
  assert.ok(html.includes('范围外发作（2026-10-01 12:00）'));
  const csv = recordsCSV(state([spanning, other]), '2026-10-02', '2026-10-02', now);
  assert.ok(csv.includes('"发作","spanning"'));
  assert.ok(!csv.includes('"发作","other"'));
  assert.ok(csv.includes('"用药","other"'));
});

test('CSV provides BOM, RFC-style quoting and formula neutralization', () => {
  const attack = entry({
    id: '=HYPERLINK("https://invalid")', notes: '  =1+1, "quoted"\nnext line',
    medications: [{ id: 'dose', name: '\t@SUM(A1)', dose: '-1+2', at: at(2), relief: null }],
  });
  const csv = recordsCSV(state([attack]), '2026-10-01', '2026-10-04', now);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.includes('"\'=HYPERLINK(""https://invalid"")"'));
  assert.ok(csv.includes('"\'  =1+1, ""quoted""\nnext line"'));
  assert.ok(csv.includes('"\'\t@SUM(A1)"'));
  assert.ok(csv.includes('"\'-1+2"'));
  assert.ok(csv.includes('\r\n'));
});

test('backup is lossless and all generators leave state unchanged', () => {
  const original = state([entry({ notes: '换行\n<原样保留>' })], { name: '张某' });
  const before = JSON.stringify(original);
  assert.deepEqual(JSON.parse(backupJSON(original)), original);
  reportHTML(original, '2026-10-01', '2026-10-04', now);
  recordsCSV(original, '2026-10-01', '2026-10-04', now);
  assert.equal(JSON.stringify(original), before);
});

test('backup uses compact JSON and remains smaller than the corresponding save request', () => {
  const original = state(Array.from({ length: 100 }, (_, index) => entry({
    id: `episode-${index}`, notes: '保持完整健康记录与换行\n'.repeat(10),
  })), { name: '中文姓名' });
  const backup = backupJSON(original);
  const submission = JSON.stringify({ expectedRevision: original.revision, state: original });
  assert.equal(backup, JSON.stringify(original));
  assert.equal(Buffer.byteLength(backup, 'utf8'), Buffer.byteLength(JSON.stringify(original), 'utf8'));
  assert.ok(Buffer.byteLength(backup, 'utf8') < Buffer.byteLength(submission, 'utf8'));
  assert.deepEqual(JSON.parse(backup), original);
  assert.ok(!backup.includes('\n'));
});

test('free text that matches coded labels or object property names remains verbatim', () => {
  const original = state([entry({
    notes: 'constructor', symptoms: ['no'],
    medications: [{ id: 'dose', name: 'good', dose: '__proto__', at: at(2), relief: 'good' }],
  })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  assert.ok(html.includes('<td>good</td>'));
  assert.ok(html.includes('<td>__proto__</td>'));
  assert.match(html, /<td\b[^>]*>constructor<\/td>/);
  assert.ok(html.includes('<td>no</td>'));
  assert.ok(html.includes('<td>明显缓解</td>'));
});

test('menstruation is reported as a recorded status rather than a causal relationship', () => {
  const original = state([entry({ menstruation: 'yes' })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const csv = recordsCSV(original, '2026-10-01', '2026-10-04', now);
  assert.ok(html.includes('当时是否处在经期'));
  assert.ok(!html.includes('与经期有关'));
  assert.ok(csv.includes('"经期状态"'));
  assert.ok(!csv.includes('"经期关系"'));
});

test('short known durations and their median use minutes instead of rounding to zero hours', () => {
  const start = at(2, 12);
  const original = state([entry({ start, end: new Date(Date.parse(start) + 60_000).toISOString() })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const csv = recordsCSV(original, '2026-10-01', '2026-10-04', now);
  assert.ok(html.includes('1 分钟；n = 1'));
  assert.ok(html.includes('<td>1 分钟</td>'));
  assert.ok(csv.includes('"1 分钟"'));
  assert.ok(!html.includes('0.0 小时'));
  assert.ok(!csv.includes('0.0 小时'));
  original.entries[0].end = new Date(Date.parse(start) + 20_000).toISOString();
  const secondsHTML = reportHTML(original, '2026-10-01', '2026-10-04', now);
  assert.ok(secondsHTML.includes('不足 1 分钟；n = 1'));
  assert.ok(secondsHTML.includes('<td>不足 1 分钟</td>'));
});

test('date-only onset prints its known date without exposing a midnight placeholder', () => {
  const original = state([entry({
    start: at(2, 0), end: null, endUnknown: true, onsetPrecision: 'day', pain: null,
  })]);
  const html = reportHTML(original, '2026-10-02', '2026-10-02', now);
  const csv = recordsCSV(original, '2026-10-02', '2026-10-02', now);
  assert.ok(html.includes('<td>2026-10-02（已知有头痛；起止时间未记录）</td>'));
  assert.ok(html.includes('未记录；n = 0'));
  assert.ok(html.includes('已结束，起止时间未记录'));
  assert.ok(html.includes('期间开始时间已知的发作'));
  assert.ok(html.includes('仅知道日期的记录'));
  assert.ok(html.includes('<td>期间开始时间已知的发作</td><td>0 次</td>'));
  assert.ok(html.includes('<td>仅知道日期的记录</td><td>1 条</td>'));
  assert.ok(html.includes('本人确认这天有头痛，具体起止时间未记录'));
  assert.ok(html.includes('开始时间 / 已知头痛日期'));
  assert.ok(csv.includes('"2026-10-02","仅日期"'));
  assert.ok(!html.includes('2026-10-02 00:00'));
  assert.ok(!csv.includes('2026-10-02 00:00'));
});

test('one-tap daily records report headache without inventing an end status, midnight or duration', () => {
  const original = state([entry({
    start: at(2, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true, pain: null,
  })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const metrics = metricRows(html);
  assert.equal(metrics['期间开始时间已知的发作'], '0 次');
  assert.equal(metrics['仅知道日期的记录'], '1 条');
  assert.equal(metrics['仍在持续'], '0 次');
  assert.equal(metrics['已结束，起止或结束时间未记录'], '0 条');
  assert.equal(metrics['是否已结束未记录'], '1 条');
  assert.equal(metrics['持续时长中位数'], '未记录；n = 0');
  assert.equal(metrics['最高疼痛评分平均值'], '未记录 / 10；n = 0');
  assert.deepEqual(tableRows(html, '序号')[0], [
    '1', '2026-10-02（当天头痛已记录；起止时间未记录）', '是否已结束未记录',
    '起止时间未记录，无法计算', '未记录', '未记录',
  ]);
  assert.deepEqual(tableRows(html, '日期').map(row => row.slice(0, 2)), [
    ['2026-10-01', '未记录'], ['2026-10-02', '有头痛'], ['2026-10-03', '未记录'], ['2026-10-04', '未记录'],
  ]);
  assert.ok(html.includes('0 / 1 条记录已填写症状（含明确无）'));
  const [row] = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  assert.equal(row['开始时间或已知头痛日期'], '2026-10-02');
  assert.equal(row['时间精度'], '仅日期');
  assert.equal(row['结束时间或状态'], '是否已结束未记录');
  assert.equal(row['完整持续时长'], '起止时间未记录，无法计算');
  assert.equal(row['疼痛0-10'], '未记录');
  assert.equal(row['伴随症状'], '未记录');
  assert.ok(!html.includes('2026-10-02 00:00'));
  assert.ok(!JSON.stringify(row).includes('00:00'));
  assert.ok(!JSON.stringify(row).includes('仍在持续'));
  assert.ok(!JSON.stringify(row).includes('已结束，'));
});

test('one-tap and legacy entries retain separate status counts and independent clinical samples', () => {
  const original = state([
    entry({ id: 'precise', pain: 6 }),
    entry({ id: 'ended-day', start: at(3, 0), end: null, endUnknown: true, onsetPrecision: 'day', pain: 0, symptoms: [] }),
    entry({ id: 'one-tap', start: at(3, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true, pain: 8, symptoms: ['畏光'] }),
    entry({ id: 'ongoing', start: at(4, 12), end: null, pain: null }),
  ]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const metrics = metricRows(html);
  assert.equal(metrics['期间开始时间已知的发作'], '2 次');
  assert.equal(metrics['仅知道日期的记录'], '2 条');
  assert.equal(metrics['仍在持续'], '1 次');
  assert.equal(metrics['已结束，起止或结束时间未记录'], '1 条');
  assert.equal(metrics['是否已结束未记录'], '1 条');
  assert.equal(metrics['最高疼痛评分平均值'], '4.7 / 10；n = 3');
  assert.equal(metrics['持续时长中位数'], '2.0 小时；n = 1');
  assert.equal(metrics['疼痛评分 ≥7 的日期'], '1 日');
  assert.deepEqual(tableRows(html, '本人记录的症状'), [['畏光', '1']]);
  assert.ok(html.includes('2 / 4 条记录已填写症状（含明确无）'));
  assert.deepEqual(tableRows(html, '日期').find(row => row[0] === '2026-10-03'), ['2026-10-03', '有头痛', '8 / 10', '无用药记录', '2', '无延续记录']);
  const rows = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  assert.equal(rows.find(row => row['对应发作ID'] === 'precise')['结束时间或状态'], '2026-10-02 14:00');
  assert.equal(rows.find(row => row['对应发作ID'] === 'precise')['完整持续时长'], '2.0 小时');
  assert.equal(rows.find(row => row['对应发作ID'] === 'ended-day')['结束时间或状态'], '已结束，起止时间未记录');
  assert.equal(rows.find(row => row['对应发作ID'] === 'one-tap')['结束时间或状态'], '是否已结束未记录');
  assert.equal(rows.find(row => row['对应发作ID'] === 'ongoing')['完整持续时长'], '仍在持续，已 6.0 小时');
  assert.equal(JSON.parse(backupJSON(original)).entries.find(item => item.id === 'one-tap').statusUnknown, true);
});

test('outside daily record dose context preserves unknown headache status without inventing an onset time', () => {
  const original = state([entry({
    start: at(1, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true,
    medications: [{ id: 'dose', name: '实际药物', dose: '1 片', at: at(2, 13), relief: null }],
  })]);
  const html = reportHTML(original, '2026-10-02', '2026-10-02', now);
  assert.ok(html.includes('范围外发作（2026-10-01（当天头痛已记录；起止时间未记录））'));
  assert.deepEqual(tableRows(html, '日期')[0], ['2026-10-02', '未记录', '未记录', '有用药记录', '未记录', '无延续记录']);
  const [row] = csvObjects(recordsCSV(original, '2026-10-02', '2026-10-02', now));
  assert.equal(row['行类型'], '用药');
  assert.equal(row['开始时间或已知头痛日期'], '2026-10-01');
  assert.equal(row['结束时间或状态'], '是否已结束未记录');
  assert.equal(row['完整持续时长'], '');
  assert.equal(row['服药时间'], '2026-10-02 13:00');
  assert.ok(!html.includes('2026-10-01 00:00'));
});

test('in-range dose context for an outside date-only episode does not invent its start time', () => {
  const original = state([entry({
    start: at(1, 0), end: null, endUnknown: true, onsetPrecision: 'day',
    medications: [{ id: 'later-dose', name: '实际药物', dose: '1 片', at: at(2, 13), relief: null }],
  })]);
  const html = reportHTML(original, '2026-10-02', '2026-10-02', now);
  const csv = recordsCSV(original, '2026-10-02', '2026-10-02', now);
  assert.ok(html.includes('范围外发作（2026-10-01（已知有头痛；起止时间未记录））'));
  assert.ok(csv.includes('"2026-10-01","仅日期"'));
  assert.ok(!html.includes('2026-10-01 00:00'));
  assert.ok(!csv.includes('2026-10-01 00:00'));
});

test('midnight report boundaries exclude an episode ending at midnight and include one continuing after it', () => {
  const original = state([
    entry({ id: 'ended-at-midnight', start: at(1, 23), end: at(2, 0), notes: '不应进入这天报告' }),
    entry({ id: 'continues', start: at(1, 23), end: local(2026, 10, 2, 0, 30), pain: 4, notes: '应保留完整九十分钟' }),
    entry({ id: 'starts-next-day', start: at(3, 0), end: at(3, 1), notes: '次日不应进入报告' }),
  ]);
  original.days = [{ date: '2026-10-02', status: 'no-headache' }];
  const html = reportHTML(original, '2026-10-02', '2026-10-02', now);
  const rows = csvObjects(recordsCSV(original, '2026-10-02', '2026-10-02', now));
  assert.deepEqual(rows.filter(row => row['行类型'] === '发作').map(row => row['对应发作ID']), ['continues']);
  assert.deepEqual(tableRows(html, '日期'), [['2026-10-02', '有头痛', '4 / 10', '无用药记录', '0', '1 条延续']]);
  assert.equal(metricRows(html)['期间开始时间已知的发作'], '0 次');
  assert.equal(metricRows(html)['持续时长中位数'], '1.5 小时；n = 1');
  assert.ok(!html.includes('不应进入这天报告'));
  assert.ok(!html.includes('次日不应进入报告'));
});

test('month boundary totals and daily statuses agree with complete records without inventing headache-free days', () => {
  const original = state([
    entry({ id: 'september', start: local(2026, 9, 30, 23, 30), end: local(2026, 10, 1, 0), pain: null }),
    entry({ id: 'date-only', start: at(2, 0), end: null, endUnknown: true, onsetPrecision: 'day', pain: 8 }),
  ]);
  original.days = [{ date: '2026-10-01', status: 'no-headache' }];
  const html = reportHTML(original, '2026-09-30', '2026-10-03', now);
  assert.deepEqual(tableRows(html, '月份', '头痛日'), [
    ['2026-09', '1', '0', '1', '1', '0', '2026-09-30 至 2026-09-30（部分月，1 日）'],
    ['2026-10', '1', '0', '2', '1', '1', '2026-10-01 至 2026-10-03（部分月，3 日）'],
  ]);
  assert.deepEqual(tableRows(html, '日期'), [
    ['2026-09-30', '有头痛', '未记录', '无用药记录', '1', '无延续记录'],
    ['2026-10-01', '已确认无头痛', '未记录', '无用药记录', '0', '无延续记录'],
    ['2026-10-02', '有头痛', '8 / 10', '无用药记录', '1', '无延续记录'],
    ['2026-10-03', '未记录', '未记录', '无用药记录', '未记录', '无延续记录'],
  ]);
  const metrics = metricRows(html);
  assert.equal(metrics['期间开始时间已知的发作'], '1 次');
  assert.equal(metrics['仅知道日期的记录'], '1 条');
  assert.equal(metrics['疼痛评分 ≥7 的日期'], '1 日');
  assert.equal(metrics['持续时长中位数'], '30 分钟；n = 1');
  assert.equal(metrics['最高疼痛评分平均值'], '8.0 / 10；n = 1');
  const rows = csvObjects(recordsCSV(original, '2026-09-30', '2026-10-03', now));
  assert.equal(rows.length, 2);
  assert.equal(rows[1]['开始时间或已知头痛日期'], '2026-10-02');
  assert.equal(rows[1]['完整持续时长'], '起止时间未记录，无法计算');
});

test('doctor charts and detail tables reconcile same-day counts, cross-month carryover and unknown days', () => {
  const original = state([
    entry({ id: 'cross-month', start: local(2026, 9, 30, 23), end: at(1, 10), pain: 2 }),
    entry({ id: 'date-a', start: at(1, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true, pain: null }),
    entry({ id: 'date-b', start: at(1, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true, pain: 5 }),
    entry({ id: 'precise', start: at(1, 15), end: at(1, 16), pain: 7 }),
  ]);
  original.days = [{ date: '2026-10-02', status: 'no-headache' }];
  const html = reportHTML(original, '2026-09-30', '2026-10-03', now);
  assert.equal(metricRows(html)['头痛记录次数'], '4 次');
  assert.equal(metricRows(html)['期间开始时间已知的发作'], '2 次');
  assert.equal(metricRows(html)['仅知道日期的记录'], '2 条');
  const septemberDay = chartData(html, 'data-date', '2026-09-30');
  const octoberDay = chartData(html, 'data-date', '2026-10-01');
  const noHeadacheDay = chartData(html, 'data-date', '2026-10-02');
  const unrecordedDay = chartData(html, 'data-date', '2026-10-03');
  assert.equal(septemberDay['data-record-count'], '1');
  assert.equal(septemberDay['data-carryover-count'], '0');
  assert.equal(octoberDay['data-record-count'], '3');
  assert.equal(octoberDay['data-carryover-count'], '1');
  assert.equal(noHeadacheDay['data-status'], 'no-headache');
  assert.equal(noHeadacheDay['data-record-count'], '0');
  assert.equal(unrecordedDay['data-status'], 'unknown');
  assert.equal(unrecordedDay['data-record-count'], '0');
  const septemberMonth = chartData(html, 'data-month', '2026-09');
  const octoberMonth = chartData(html, 'data-month', '2026-10');
  assert.equal(septemberMonth['data-record-count'], '1');
  assert.equal(septemberMonth['data-headache-days'], '1');
  assert.equal(octoberMonth['data-record-count'], '3');
  assert.equal(octoberMonth['data-headache-days'], '1');
  assert.equal(octoberMonth['data-unknown-days'], '1');
  assert.equal(octoberMonth['data-partial-month'], 'true');
  assert.deepEqual(tableRows(html, '日期'), [
    ['2026-09-30', '有头痛', '2 / 10', '无用药记录', '1', '无延续记录'],
    ['2026-10-01', '有头痛', '7 / 10', '无用药记录', '3', '1 条延续'],
    ['2026-10-02', '已确认无头痛', '未记录', '无用药记录', '0', '无延续记录'],
    ['2026-10-03', '未记录', '未记录', '无用药记录', '未记录', '无延续记录'],
  ]);
  assert.deepEqual(tableRows(html, '月份', '头痛日'), [
    ['2026-09', '1', '0', '1', '1', '0', '2026-09-30 至 2026-09-30（部分月，1 日）'],
    ['2026-10', '1', '0', '2', '3', '1', '2026-10-01 至 2026-10-03（部分月，3 日）'],
  ]);
  const exported = csvObjects(recordsCSV(original, '2026-09-30', '2026-10-03', now));
  assert.equal(exported.length, 4);
  assert.equal(exported.filter(row => row['结束时间或状态'] === '是否已结束未记录').length, 2);
  assert.ok(!html.includes('2026-10-01 00:00'));
});

test('standalone doctor charts precede numeric tables and retain full-month coverage without scripts', () => {
  const original = state([entry({ start: at(2, 0), end: null, endUnknown: true, onsetPrecision: 'day', statusUnknown: true, pain: null })]);
  const html = reportHTML(original, '2026-09-01', '2026-09-30', now);
  const chart = chartData(html, 'data-month', '2026-09');
  assert.equal(chart['data-record-count'], '0');
  assert.equal(chart['data-headache-days'], '0');
  assert.equal(chart['data-unknown-days'], '30');
  assert.equal(chart['data-partial-month'], 'false');
  assert.ok(html.indexOf('data-month="2026-09"') < html.indexOf('<th scope="col">指标</th>'));
  assert.ok(html.includes('<svg'));
  assert.ok(!html.includes('<script'));
  assert.deepEqual(tableRows(html, '月份', '头痛日'), [['2026-09', '0', '0', '0', '0', '30', '2026-09-01 至 2026-09-30（整月，30 日）']]);
  assert.ok(tableRows(html, '日期').every(row => row[1] === '未记录' && row[4] === '未记录'));
  assert.ok(html.includes('首尾月份未覆盖整月时明确标为“部分月”'));
  assert.ok(html.includes('未记录日不能视为无头痛日'));
});

test('leap-day reports enumerate real calendar days and retain full cross-midnight duration', () => {
  const original = state([entry({
    start: local(2024, 2, 28, 23, 50), end: local(2024, 2, 29, 0, 10), pain: 2,
  })]);
  original.days = [{ date: '2024-03-01', status: 'no-headache' }];
  const html = reportHTML(original, '2024-02-28', '2024-03-01', now);
  assert.deepEqual(tableRows(html, '日期').map(row => row.slice(0, 2)), [
    ['2024-02-28', '有头痛'], ['2024-02-29', '有头痛'], ['2024-03-01', '已确认无头痛'],
  ]);
  assert.deepEqual(tableRows(html, '月份', '头痛日'), [
    ['2024-02', '2', '0', '2', '1', '0', '2024-02-28 至 2024-02-29（部分月，2 日）'],
    ['2024-03', '0', '0', '1', '0', '0', '2024-03-01 至 2024-03-01（部分月，1 日）'],
  ]);
  assert.equal(metricRows(html)['持续时长中位数'], '20 分钟；n = 1');
});

test('actual dose dates, inclusive last day and outside context reconcile between summary, daily table and CSV', () => {
  const original = state([
    entry({
      id: 'spanning', start: at(1, 21), end: at(2, 11), pain: 6,
      medications: [
        { id: 'before', name: '时段外上下文药', dose: '1 片', at: at(1, 22), relief: 'good' },
        { id: 'first-midnight', name: '药甲', dose: '200 mg', at: at(2, 0), relief: 'good' },
        { id: 'after-midnight', name: '末日后药', dose: '1 片', at: at(4, 0), relief: 'none' },
      ],
    }),
    entry({
      id: 'outside-episode', start: at(1, 9), end: at(1, 11),
      medications: [
        { id: 'repeat-same-day', name: '药甲', dose: '100 mg', at: at(2, 15), relief: null },
        { id: 'last-second', name: '药乙', dose: '5 ml', at: local(2026, 10, 3, 23, 59, 59), relief: 'partial' },
      ],
    }),
  ], { medications: [{ name: '只是快捷模板的药，不能计为服药', dose: '1 片' }] });
  const html = reportHTML(original, '2026-10-02', '2026-10-03', now);
  const rows = csvObjects(recordsCSV(original, '2026-10-02', '2026-10-03', now));
  assert.deepEqual(tableRows(html, '药物名称'), [
    ['药甲', '1', '2', '1 / 1'], ['药乙', '1', '1', '0 / 1'],
  ]);
  const doseRows = rows.filter(row => row['行类型'] === '用药');
  const counted = doseRows.filter(row => row['统计范围'] === '在所选时段内');
  const context = doseRows.filter(row => row['统计范围'] === '时段外 · 仅供发作上下文');
  assert.equal(counted.length, 3);
  assert.equal(context.length, 2);
  assert.deepEqual(new Set(counted.map(row => row['服药时间'].slice(0, 10))), new Set(['2026-10-02', '2026-10-03']));
  assert.equal(counted.filter(row => row['对应发作ID'] === 'outside-episode').length, 2);
  assert.equal(rows.filter(row => row['行类型'] === '发作').length, 1);
  assert.deepEqual(tableRows(html, '日期').map(row => row.slice(0, 2)), [
    ['2026-10-02', '有头痛'], ['2026-10-03', '未记录'],
  ]);
  assert.ok(tableRows(html, '日期').every(row => row[3] === '有用药记录'));
  assert.equal(tableRows(html, '对应记录序号').length, doseRows.length);
  assert.equal(metricRows(html)['持续时长中位数'], '14.0 小时；n = 1');
  assert.ok(!html.includes('只是快捷模板的药'));
  assert.ok(!rows.some(row => row['药物名称'].includes('只是快捷模板的药')));
});

test('zero scores, unrecorded selections and ongoing episodes preserve independent sample denominators', () => {
  const original = state([
    entry({ id: 'zero', start: at(1, 8), end: at(1, 10), pain: 0, symptoms: [], triggers: [] }),
    entry({ id: 'known', start: at(2, 8), end: at(2, 12), pain: 8, symptoms: ['恶心'], triggers: null }),
    entry({ id: 'unknown-end', start: at(3, 8), end: null, endUnknown: true, pain: null }),
    entry({ id: 'ongoing', start: at(4, 8), end: null, pain: 4, symptoms: ['恶心'], triggers: ['压力'] }),
    entry({ id: 'only-day', start: at(3, 0), end: null, endUnknown: true, onsetPrecision: 'day', pain: null }),
  ]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const metrics = metricRows(html);
  assert.equal(metrics['期间开始时间已知的发作'], '4 次');
  assert.equal(metrics['仅知道日期的记录'], '1 条');
  assert.equal(metrics['与时段相交的记录'], '5 条');
  assert.equal(metrics['仍在持续'], '1 次');
  assert.equal(metrics['已结束，起止或结束时间未记录'], '2 条');
  assert.equal(metrics['最高疼痛评分平均值'], '4.0 / 10；n = 3');
  assert.equal(metrics['持续时长中位数'], '3.0 小时；n = 2');
  assert.deepEqual(tableRows(html, '本人记录的症状'), [['恶心', '2']]);
  assert.deepEqual(tableRows(html, '可能相关因素'), [['压力', '1']]);
  assert.ok(html.includes('3 / 5 条记录已填写症状（含明确无）'));
  assert.ok(html.includes('2 / 5 条记录已填写诱因（含明确无）'));
  const exported = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  assert.equal(exported.find(row => row['对应发作ID'] === 'zero')['疼痛0-10'], '0');
  assert.equal(exported.find(row => row['对应发作ID'] === 'zero')['伴随症状'], '已确认无');
  assert.equal(exported.find(row => row['对应发作ID'] === 'unknown-end')['伴随症状'], '未记录');
  assert.equal(exported.find(row => row['对应发作ID'] === 'ongoing')['完整持续时长'], '仍在持续，已 10.0 小时');
});

test('Chinese names, punctuation, multiline values and every clinical field survive HTML and CSV escaping', () => {
  const note = '中文记录：张“明”\n第二行, 含"引号"、单引号\'、<尖括号> & &lt; 原文';
  const original = state([entry({
    onsetPrecision: 'approximate', pain: 9, locations: ['眼周<&>'], character: ['跳痛"\''],
    symptoms: ['恶心 & 不适'], triggers: ['压力,睡眠'], impact: 'bedrest', menstruation: 'unsure', notes: note,
    medications: [{ id: 'dose-special', name: '中文药"<&>', dose: '1 片, 200 mg', at: at(2, 13), relief: 'partial' }],
  })], { name: '张<明> & "月"\'' });
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const rows = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  const attack = rows.find(row => row['行类型'] === '发作');
  const dose = rows.find(row => row['行类型'] === '用药');
  assert.ok(html.includes('姓名：张&lt;明&gt; &amp; &quot;月&quot;&#39;'));
  assert.ok(tableRows(html, '序号').some(row => row[1].endsWith('（约）')));
  assert.equal(attack['时间精度'], '约');
  assert.equal(attack['备注'], note);
  assert.equal(attack['部位'], '眼周<&>');
  assert.equal(attack['感觉'], '跳痛"\'');
  assert.equal(attack['伴随症状'], '恶心 & 不适');
  assert.equal(attack['怀疑诱因'], '压力,睡眠');
  assert.equal(attack['活动影响'], '需要卧床');
  assert.equal(attack['经期状态'], '不确定');
  assert.equal(dose['药物名称'], '中文药"<&>');
  assert.equal(dose['剂量'], '1 片, 200 mg');
  assert.equal(dose['本人感受的效果'], '部分缓解');
  assert.ok(html.includes('第二行, 含&quot;引号&quot;、单引号&#39;、&lt;尖括号&gt; &amp; &amp;lt; 原文'));
});

test('spreadsheet formula prefixes remain literal across all user-controlled export columns', () => {
  for (const dangerous of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '  =1+1', '\uFEFF=1+1', '\u200B=1+1', '\n=1+1', '\r@SUM(A1)', '\t+1']) {
    const original = state([entry({
      id: dangerous, notes: dangerous, locations: [dangerous], character: [dangerous],
      symptoms: [dangerous], triggers: [dangerous],
      medications: [{ id: 'dose', name: dangerous, dose: dangerous, at: at(2), relief: null }],
    })]);
    const rows = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
    const attack = rows.find(row => row['行类型'] === '发作');
    const dose = rows.find(row => row['行类型'] === '用药');
    for (const field of ['对应发作ID', '备注', '部位', '感觉', '伴随症状', '怀疑诱因']) assert.equal(attack[field], `'${dangerous}`);
    assert.equal(dose['药物名称'], `'${dangerous}`);
    assert.equal(dose['剂量'], `'${dangerous}`);
  }
});

test('empty and out-of-window reports do not invent samples, treatments or patient identity', () => {
  const original = state([entry({ start: at(1), end: at(1, 14), notes: '时段外敏感备注' })]);
  const html = reportHTML(original, '2026-10-03', '2026-10-04', now);
  assert.equal(metricRows(html)['最高疼痛评分平均值'], '未记录 / 10；n = 0');
  assert.equal(metricRows(html)['持续时长中位数'], '未记录；n = 0');
  assert.equal(metricRows(html)['期间开始时间已知的发作'], '0 次');
  assert.equal(metricRows(html)['与时段相交的记录'], '0 条');
  assert.ok(tableRows(html, '日期').every(row => row[1] === '未记录'));
  assert.ok(!html.includes('时段外敏感备注'));
  assert.ok(!html.includes('姓名：'));
  assert.deepEqual(csvObjects(recordsCSV(original, '2026-10-03', '2026-10-04', now)), []);
  assert.throws(() => reportHTML(original, '2026-10-04', '2026-10-03', now), /早于/);
  assert.throws(() => recordsCSV(original, '2026-02-30', '2026-03-01', now), /无效/);
});

test('maximum-length multiline notes retain their beginning, ending and complete content in both formats', () => {
  const note = `备注开始\n${'病人的完整感受<&>，\n'.repeat(300)}`.padEnd(3996, '诊') + '备注结束';
  assert.equal(note.length, 4000);
  const original = state([entry({ notes: note })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const exported = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  assert.equal(exported[0]['备注'], note);
  const detailsTable = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)]
    .find(match => match[1].includes('当时是否处在经期'));
  const notes = [...detailsTable[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(decodeHTML(notes.at(-1)[1]), note);
  assert.ok(!html.includes('overflow:hidden'));
});

test('timezone-specific report windows assign episodes and actual doses to local dates', () => {
  const moduleURL = new URL('../reports.js', import.meta.url).href;
  const script = `
    import {recordsCSV} from ${JSON.stringify(moduleURL)};
    const entry={id:'timezone-record',start:'2026-10-01T23:30:00.000Z',end:'2026-10-02T00:30:00.000Z',endUnknown:false,onsetPrecision:'exact',pain:4,symptoms:null,locations:null,character:null,triggers:null,impact:null,menstruation:null,notes:'',medications:[{id:'dose',name:'actual-dose',dose:'1',at:'2026-10-01T23:45:00.000Z',relief:null}]};
    const state={schemaVersion:1,revision:0,profile:{name:'',theme:'light',medications:[]},entries:[entry],days:[]};
    const csv=recordsCSV(state,'2026-10-01','2026-10-01',new Date('2026-10-04T12:00:00Z'));
    process.stdout.write(JSON.stringify({csv,zone:Intl.DateTimeFormat().resolvedOptions().timeZone}));`;
  const inZone = zone => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const utc = inZone('UTC'), shanghai = inZone('Asia/Shanghai');
  assert.equal(utc.zone, 'UTC');
  assert.equal(shanghai.zone, 'Asia/Shanghai');
  const utcRows = csvObjects(utc.csv), shanghaiRows = csvObjects(shanghai.csv);
  assert.equal(utcRows.length, 2);
  assert.equal(utcRows.find(row => row['行类型'] === '发作')['开始时间或已知头痛日期'], '2026-10-01 23:30');
  assert.equal(utcRows.find(row => row['行类型'] === '用药')['服药时间'], '2026-10-01 23:45');
  assert.deepEqual(shanghaiRows, []);
});

test('medication details sort by actual instant even when ISO input strings use different timezone offsets', () => {
  const original = state([entry({
    medications: [
      { id: 'later', name: '第二剂', dose: '1', at: '2026-10-02T06:00:00.000Z', relief: null },
      { id: 'earlier', name: '第一剂', dose: '1', at: '2026-10-02T13:00:00+08:00', relief: null },
    ],
  })]);
  const html = reportHTML(original, '2026-10-01', '2026-10-04', now);
  const rows = csvObjects(recordsCSV(original, '2026-10-01', '2026-10-04', now));
  assert.deepEqual(rows.filter(row => row['行类型'] === '用药').map(row => row['药物名称']), ['第一剂', '第二剂']);
  assert.deepEqual(tableRows(html, '对应记录序号').map(row => row[2]), ['第一剂', '第二剂']);
});

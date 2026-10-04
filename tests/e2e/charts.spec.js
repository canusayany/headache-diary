import { test, expect, nav, reportChartCase } from './fixtures.js';
import { promises as fs } from 'node:fs';

const dayButton = (page, date) => page.getByTestId('daily-headache-chart')
  .locator(`[data-action="report-day"][data-date="${date}"]`);
const monthRows = page => page.getByTestId('monthly-headache-chart').locator('[data-month]');

async function setRange(page, from, to) {
  await page.locator('#report-from').fill(from);
  await page.locator('#report-to').fill(to);
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.getByTestId('daily-headache-chart')).toBeVisible();
  await expect(page.getByTestId('monthly-headache-chart')).toBeVisible();
}

async function openCharts(page, diary) {
  const scenario = reportChartCase();
  await diary.seed(scenario.data);
  await page.reload();
  await nav(page, '报告');
  await setRange(page, scenario.from, scenario.to);
  return scenario;
}

async function labels(locator) {
  return locator.evaluateAll(elements => elements.map(element => ({
    month: element.dataset.month,
    label: element.getAttribute('aria-label') || element.querySelector('title')?.textContent || element.textContent,
  })));
}

test('每日与每月次数：同日三条、仅日期计一次、跨年延续不重复、未知不冒充零次', async ({ patient: page, diary }) => {
  const scenario = await openCharts(page, diary);
  await expect(page.getByRole('heading', { name: '每日头痛记录', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '每月头痛次数', exact: true })).toBeVisible();
  await expect(page.getByTestId('daily-headache-chart').locator('[data-action="report-day"]')).toHaveCount(35);
  await expect(dayButton(page, '2023-12-31')).toHaveAttribute('aria-label', /3\s*次/);
  await expect(dayButton(page, '2024-01-01')).toHaveAttribute('aria-label', /延续/);
  await expect(dayButton(page, '2024-01-01')).toHaveAttribute('aria-label', /0\s*次/);
  await expect(dayButton(page, '2024-01-02')).toHaveAttribute('aria-label', /1\s*次/);
  await expect(dayButton(page, '2024-02-01')).toHaveAttribute('aria-label', /1\s*次/);
  await expect(dayButton(page, '2024-01-03')).toHaveAttribute('aria-label', /无头痛/);
  await expect(dayButton(page, '2024-01-03')).toHaveAttribute('aria-label', /0\s*次/);
  await expect(dayButton(page, '2023-12-30')).toHaveAttribute('aria-label', /未记录/);
  await expect(dayButton(page, '2023-12-30')).not.toHaveAttribute('aria-label', /0\s*次/);
  await expect(dayButton(page, '2023-12-31').locator('.hc-value')).toHaveText('3次');
  await expect(dayButton(page, '2024-01-01').locator('.hc-value')).toHaveText('延续');
  await expect(dayButton(page, '2024-01-02').locator('.hc-value')).toHaveText('1次');
  await expect(dayButton(page, '2024-01-03').locator('.hc-value')).toHaveText('无');
  await expect(dayButton(page, '2023-12-30').locator('.hc-value')).toHaveText('?');

  const months = await labels(monthRows(page));
  expect(months.map(row => row.month)).toEqual(scenario.months);
  months.forEach((row, index) => expect(row.label).toMatch(new RegExp(`${scenario.countByMonth[index]}\\s*次`)));
  expect(months[0].label).toContain('部分月');
  expect(months[1].label).not.toContain('部分月');
  expect(months[2].label).toContain('部分月');
  expect(months[0].label).toMatch(/未记录\s*1\s*天/);
  expect(months[1].label).toMatch(/未记录\s*28\s*天/);
  expect(months[2].label).toMatch(/未记录\s*1\s*天/);
  const bars = await monthRows(page).evaluateAll(rows => rows.map(row => ({
    width: Number(row.querySelector('rect').getAttribute('width')),
    start: Number(row.querySelector('rect').getAttribute('x')),
  })));
  expect(bars[0].width / bars[1].width).toBeCloseTo(3, 8);
  expect(bars[1].width).toBe(bars[2].width);
  expect(new Set(bars.map(bar => bar.start)).size).toBe(1);
  expect(bars[0].start).toBeGreaterThan(0);
  await expect(page.locator('.summary-note')).toContainText('30 天未记录');
  expect((await diary.diskState()).entries).toHaveLength(5);
});

test('报告日期可键盘查看当天条目；缩小范围保留延续但只计范围内新记录，浏览不写盘', async ({ patient: page, diary }) => {
  await openCharts(page, diary);
  const before = await diary.diskState();
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/state') && request.method() === 'PUT') writes++; });
  await dayButton(page, '2023-12-31').focus();
  await page.keyboard.press('Enter');
  const details = page.getByTestId('report-day-details');
  await expect(page.getByRole('heading', { name: '就诊报告', exact: true })).toBeVisible();
  await expect(details).toContainText('2023-12-31');
  await expect(details.locator('.entry-row')).toHaveCount(3);
  expect(await details.locator('.entry-row').evaluateAll(rows => rows.map(row => row.dataset.id).sort()))
    .toEqual(['chart-cross-year', 'chart-dec-afternoon', 'chart-dec-morning']);

  await dayButton(page, '2024-01-01').focus();
  await page.keyboard.press('Space');
  await expect(details).toContainText('延续');
  await expect(details.locator('.entry-row')).toHaveCount(1);
  await expect(details.locator('.entry-row')).toHaveAttribute('data-id', 'chart-cross-year');
  await details.locator('.entry-row').click();
  await expect(page.getByLabel('想补充的话（可选）')).toHaveValue('合成病例：跨年延续');
  await page.keyboard.press('Escape');

  await setRange(page, '2024-01-01', '2024-01-03');
  await expect(page.getByTestId('daily-headache-chart').locator('[data-action="report-day"]')).toHaveCount(3);
  const clipped = await labels(monthRows(page));
  expect(clipped).toHaveLength(1);
  expect(clipped[0].month).toBe('2024-01');
  expect(clipped[0].label).toMatch(/1\s*次/);
  expect(clipped[0].label).toContain('部分月');
  await dayButton(page, '2024-01-01').click();
  await expect(details.locator('.entry-row')).toHaveAttribute('data-id', 'chart-cross-year');
  expect(writes).toBe(0);
  expect(await diary.diskState()).toEqual(before);
});

test('暗色报告图表在窄屏和320px窗口无横向溢出，图表日期可点选', async ({ patient: page, diary }, info) => {
  await openCharts(page, diary);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      charts: [...document.querySelectorAll('[data-testid="daily-headache-chart"],[data-testid="monthly-headache-chart"]')]
        .map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }),
    }));
    expect(bounds.document).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.charts).toHaveLength(2);
    for (const chart of bounds.charts) {
      expect(chart.left).toBeGreaterThanOrEqual(0);
      expect(chart.right).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(chart.width).toBeGreaterThan(100);
    }
    await dayButton(page, '2024-01-02').click();
    await expect(page.getByTestId('report-day-details').locator('.entry-row')).toHaveAttribute('data-id', 'chart-jan-date');
  }
  await page.screenshot({ path: info.outputPath('report-charts-dark-320.png'), fullPage: true });
  await info.attach('report-charts-dark-320.png', { path: info.outputPath('report-charts-dark-320.png'), contentType: 'image/png' });
});

test('近6个月按六个自然月覆盖，31日不跳过二月且保留闰日；空白月份显示未记录', async ({ patient: page, diary }) => {
  // July 31 minus five months must start on February 1, rather than roll into
  // March when applying setMonth to a date whose day number is still 31.
  await page.clock.setFixedTime(new Date('2024-07-31T12:00:00+08:00'));
  await page.reload();
  const before = await diary.state();
  await nav(page, '报告');
  await page.getByRole('button', { name: '近6个月', exact: true }).click();
  await expect(page.locator('#report-from')).toHaveValue('2024-02-01');
  await expect(page.locator('#report-to')).toHaveValue('2024-07-31');
  await expect(page.getByTestId('daily-headache-chart').locator('[data-action="report-day"]')).toHaveCount(182);
  await expect(dayButton(page, '2024-02-29')).toHaveAttribute('aria-label', /未记录/);
  const months = await labels(monthRows(page));
  expect(months.map(row => row.month)).toEqual(['2024-02', '2024-03', '2024-04', '2024-05', '2024-06', '2024-07']);
  for (const month of months) {
    expect(month.label).toContain('未记录');
    expect(month.label).not.toMatch(/0\s*次/);
    expect(month.label).not.toContain('部分月');
  }
  await page.getByRole('button', { name: '近 28 天', exact: true }).click();
  await expect(page.locator('#report-from')).toHaveValue('2024-07-04');
  await expect(page.getByTestId('daily-headache-chart').locator('[data-action="report-day"]')).toHaveCount(28);
  expect(await diary.state()).toEqual(before);
});

test('超过两年日历分组可往返、换范围回第一组；所有26个月及763天导出完整', async ({ patient: page, diary, context }, info) => {
  test.setTimeout(60000);
  await openCharts(page, diary);
  const before = await diary.diskState();
  let writes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/state') && request.method() === 'PUT') writes++; });
  await setRange(page, '2022-01-01', '2024-02-02');
  const daily = page.getByTestId('daily-headache-chart');
  const pager = page.getByRole('navigation', { name: /^日历分页/ });
  const previous = pager.getByRole('button', { name: '上一组月份', exact: true });
  const next = pager.getByRole('button', { name: '下一组月份', exact: true });
  const expectedMonths = Array.from({ length: 26 }, (_, index) =>
    `${2022 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`);
  const shownDates = () => daily.locator('[data-action="report-day"]').evaluateAll(buttons => buttons.map(button => button.dataset.date));
  const expectCalendarPage = async (first, last, count, group) => {
    await expect(daily.locator('[data-action="report-day"]')).toHaveCount(count);
    const dates = await shownDates();
    expect(dates[0]).toBe(first);
    expect(dates.at(-1)).toBe(last);
    expect(new Set(dates).size).toBe(count);
    await expect(pager).toContainText(`第${group}/3组`);
    await expect(pager).toHaveAttribute('aria-label', `日历分页，第${group}/3组`);
    expect((await labels(monthRows(page))).map(row => row.month)).toEqual(expectedMonths);
    await expect(page.getByTestId('monthly-headache-chart').locator('.hc-intro')).toContainText('5 次');
  };

  await expectCalendarPage('2022-01-01', '2022-12-31', 365, 1);
  await expect(daily.locator('.hc-calendar-month')).toHaveCount(12);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press('Enter');
  await expectCalendarPage('2023-01-01', '2023-12-31', 365, 2);
  await expect(pager).toBeFocused();
  await dayButton(page, '2023-12-31').click();
  await expect(page.getByTestId('report-day-details').locator('.entry-row')).toHaveCount(3);
  await next.click();
  await expectCalendarPage('2024-01-01', '2024-02-02', 33, 3);
  await expect(pager).toBeFocused();
  await expect(next).toBeDisabled();
  await expect(page.getByTestId('report-day-details')).toHaveCount(0);
  await expect(dayButton(page, '2024-01-01')).toHaveAttribute('data-carryover-count', '1');

  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV 明细', exact: true }).click();
  const csvPath = info.outputPath('long-range-records.csv');
  await (await csvEvent).saveAs(csvPath);
  const csv = await fs.readFile(csvPath, 'utf8');
  for (const entry of before.entries) expect(csv).toContain(entry.id);

  await page.getByRole('button', { name: '预览就诊报告', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 HTML 报告', exact: true }).click();
  const sourcePath = info.outputPath('long-range-doctor-report.html');
  await (await downloadEvent).saveAs(sourcePath);
  const exportPage = await context.newPage();
  await exportPage.setContent(await fs.readFile(sourcePath, 'utf8'));
  const exportedDaily = exportPage.getByTestId('daily-headache-chart');
  await expect(exportedDaily.locator('.hc-calendar-month')).toHaveCount(26);
  await expect(exportedDaily.locator('[data-date]')).toHaveCount(763);
  await expect(exportedDaily.locator('[data-date="2022-01-01"]')).toHaveCount(1);
  await expect(exportedDaily.locator('[data-date="2024-02-02"]')).toHaveCount(1);
  await expect(exportedDaily.locator('[data-date="2023-12-31"]')).toHaveAttribute('data-record-count', '3');
  await expect(exportedDaily.locator('[data-date="2024-01-01"]')).toHaveAttribute('data-carryover-count', '1');
  expect((await labels(monthRows(exportPage))).map(row => row.month)).toEqual(expectedMonths);
  await expect(exportPage.getByRole('navigation', { name: /^日历分页/ })).toHaveCount(0);
  await expect(exportPage.locator('body')).toContainText('合成病例：十二月早间');
  await expect(exportPage.locator('body')).toContainText('合成病例：二月仅日期');
  await exportPage.close();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();

  await previous.click();
  await expectCalendarPage('2023-01-01', '2023-12-31', 365, 2);
  await expect(pager).toBeFocused();
  await previous.click();
  await expectCalendarPage('2022-01-01', '2022-12-31', 365, 1);
  await expect(pager).toBeFocused();
  await next.click();
  await next.click();
  // The new four-group range still has a valid page index 2. This catches an
  // omitted reset that would be hidden by merely clamping a one-page range.
  await setRange(page, '2021-01-01', '2024-02-02');
  await expect(pager).toContainText('第1/4组');
  expect((await shownDates())[0]).toBe('2021-01-01');
  await expect(previous).toBeDisabled();
  await expect(page.getByTestId('report-day-details')).toHaveCount(0);
  await page.getByRole('button', { name: '近6个月', exact: true }).click();
  await expect(pager).toHaveCount(0);
  await expect(daily.locator('.hc-calendar-month')).toHaveCount(6);
  expect(writes).toBe(0);
  expect(await diary.diskState()).toEqual(before);
});

test('医生HTML包含相同每日/月图与计数，无脚本且能打印实际A4 PDF', async ({ patient: page, diary, context }, info) => {
  await openCharts(page, diary);
  await page.getByRole('button', { name: '预览就诊报告', exact: true }).click();
  const report = page.frameLocator('#report-frame');
  await expect(report.getByRole('heading', { name: '每日头痛记录', exact: true })).toBeVisible();
  await expect(report.getByRole('heading', { name: '每月头痛次数', exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 HTML 报告', exact: true }).click();
  const sourcePath = info.outputPath('doctor-chart-report.html');
  await (await downloadEvent).saveAs(sourcePath);
  const html = await fs.readFile(sourcePath, 'utf8');
  expect(html).not.toMatch(/<script\b/i);
  const printPage = await context.newPage();
  await printPage.setViewportSize({ width: 794, height: 1123 });
  await printPage.setContent(html);
  const daily = printPage.getByTestId('daily-headache-chart');
  const monthly = printPage.getByTestId('monthly-headache-chart');
  await expect(daily).toBeVisible();
  await expect(monthly).toBeVisible();
  await expect(daily.locator('[data-date]')).toHaveCount(35);
  await expect(daily.locator('[data-date="2023-12-31"]')).toHaveAttribute('data-record-count', '3');
  await expect(daily.locator('[data-date="2024-01-01"]')).toHaveAttribute('data-record-count', '0');
  await expect(daily.locator('[data-date="2024-01-01"]')).toHaveAttribute('data-carryover-count', '1');
  await expect(daily.locator('[data-date="2024-01-02"]')).toHaveAttribute('data-record-count', '1');
  await expect(daily.locator('[data-date="2023-12-30"]')).toHaveAttribute('aria-label', /未记录/);
  await expect(daily.locator('[data-date="2023-12-30"]')).not.toHaveAttribute('aria-label', /0\s*次/);
  await expect(monthly.locator('svg')).toHaveCount(1);
  const printedMonths = await labels(monthRows(printPage));
  expect(printedMonths.map(row => row.month)).toEqual(['2023-12', '2024-01', '2024-02']);
  printedMonths.forEach((row, index) => expect(row.label).toMatch(new RegExp(`${[3, 1, 1][index]}\\s*次`)));
  const dailyTable = printPage.getByRole('heading', { name: '逐日记录状态', exact: true }).locator('..').getByRole('table');
  const dailyRow = date => dailyTable.getByRole('row').filter({ has: printPage.getByRole('cell', { name: date, exact: true }) });
  await expect(dailyRow('2023-12-31').getByRole('cell').nth(4)).toHaveText('3');
  await expect(dailyRow('2024-01-01').getByRole('cell').nth(4)).toHaveText('0');
  await expect(dailyRow('2024-01-01').getByRole('cell').nth(5)).toHaveText('1 条延续');
  await expect(dailyRow('2024-01-02').getByRole('cell').nth(4)).toHaveText('1');
  await expect(dailyRow('2023-12-30').getByRole('cell').nth(4)).toHaveText('未记录');
  await expect(dailyRow('2024-01-03').getByRole('cell').nth(4)).toHaveText('0');
  await expect(printPage.locator('body')).toContainText('跨日延续不重复');
  await printPage.evaluate(() => document.fonts.ready);
  await printPage.emulateMedia({ media: 'print' });
  await expect(daily).toBeVisible();
  await expect(monthly).toBeVisible();
  await printPage.screenshot({ path: info.outputPath('doctor-chart-print-layout.png'), fullPage: true });
  const pdf = await printPage.pdf({ path: info.outputPath('doctor-chart-report-a4.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(10000);
  await info.attach('doctor-chart-report-a4.pdf', { body: pdf, contentType: 'application/pdf' });
  await info.attach('doctor-chart-print-layout.png', { path: info.outputPath('doctor-chart-print-layout.png'), contentType: 'image/png' });
  await printPage.close();
});

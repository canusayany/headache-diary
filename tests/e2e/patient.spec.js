import { test, expect, emptyState, recordOnce, seedExact, nav, localValue, confirmedTiming } from './fixtures.js';
import { promises as fs } from 'node:fs';

test('一次真实点击即写入磁盘，无开始结束步骤，关窗重开可直接记下一次', async ({ patient: page, diary, context }, info) => {
  let writes=0;
  page.on('request',request=>{if(request.url().endsWith('/api/state')&&request.method()==='PUT')writes++;});
  const entry = await recordOnce(page, diary);
  const timing = await confirmedTiming(page);
  const elapsed = timing.confirmedMs;
  expect(elapsed).toBeLessThan(1500);
  expect(writes).toBe(1);
  expect(Math.abs(Date.parse(entry.createdAt) - timing.clickWallTime)).toBeLessThan(200);
  expect(entry.onsetPrecision).toBe('day');
  expect(entry.statusUnknown).toBe(true);
  expect(entry.endUnknown).toBe(true);
  expect(entry.pain).toBeNull();
  expect(entry.symptoms).toBeNull();
  expect(entry.end).toBeNull();
  expect(await page.locator('dialog').count()).toBe(1);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('[data-action="start"],[data-action="stop"],[data-testid="end-headache"]')).toHaveCount(0);
  await expect(page.getByText('可以直接关闭窗口，先休息。',{exact:true})).toBeVisible();
  expect((await diary.diskState()).entries[0]).toEqual(entry);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(diary.url);
  await expect(reopened.getByTestId('record-headache')).toBeVisible();
  await expect(reopened.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await expect(reopened.locator('[data-action="start"],[data-action="stop"]')).toHaveCount(0);
  expect((await diary.state()).entries[0]).toEqual(entry);
  const next=await recordOnce(reopened,diary);
  expect(next.id).not.toBe(entry.id);
  expect(next.statusUnknown).toBe(true);
  expect((await diary.diskState()).entries).toHaveLength(2);
  await info.attach('one-click-latency.json', { body: JSON.stringify({ oneTapMs: elapsed, requiredFields: 0, clicks: 1, initialPutCount:1 }), contentType: 'application/json' });
});

test('仅记日期：历史与报告不虚构00:00、持续时长或已结束状态', async ({ patient: page, diary }) => {
  const entry = await recordOnce(page, diary);
  expect(entry.onsetPrecision).toBe('day');
  expect(entry.endUnknown).toBe(true);
  expect(entry.end).toBeNull();
  expect(entry.statusUnknown).toBe(true);
  await expect(page.getByTestId('end-headache')).not.toBeVisible();
  await nav(page, '历史');
  await expect(page.locator('.entry-row')).toContainText('时间未记录');
  await expect(page.locator('.entry-row')).not.toContainText('00:00');
  await expect(page.locator('.entry-row')).not.toContainText('已结束');
  await nav(page, '报告');
  await page.getByRole('button', { name: '预览就诊报告' }).click();
  const report = page.frameLocator('#report-frame').locator('body');
  await expect(report).toContainText('起止时间未记录');
  await expect(report).not.toContainText('00:00');
  expect((await diary.state()).entries).toHaveLength(1);
});

test('精确旧记录可修改备注且秒数不变，首页仍只有一次记录入口', async ({ patient: page, diary }) => {
  const entry=await seedExact(diary);
  await page.reload();
  await expect(page.getByTestId('record-headache')).toBeVisible();
  await expect(page.locator('[data-action="start"],[data-action="stop"]')).toHaveCount(0);
  await page.getByRole('button',{name:'补时间或症状',exact:true}).click();
  await page.getByLabel('想补充的话（可选）').fill('只修改备注，不修改精确时间');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved=(await diary.diskState()).entries[0];
  expect(saved.start).toBe(entry.start);
  expect(saved.end).toBe(entry.end);
  expect(saved.notes).toBe('只修改备注，不修改精确时间');
});

test('疼痛可不填、一键选、精确选，也能清回未知；原始秒数不损失', async ({ patient: page, diary }) => {
  const original = await recordOnce(page, diary);
  await page.getByRole('button', { name: '重度 8 / 10 分' }).click();
  await expect(page.getByRole('button', { name: '重度 8 / 10 分' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('已记 8/10 · 调整分数', { exact: true }).click();
  await page.getByRole('button', { name: '最高疼痛 9 分', exact: true }).click();
  await expect(page.getByText('已记 9/10 · 调整分数', { exact: true })).toBeVisible();
  expect((await diary.state()).entries[0].pain).toBe(9);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await expect(page.getByLabel('头痛开始时间')).not.toBeVisible();
  await page.getByLabel('这次最痛时（0–10 分，可不填）').fill('');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const updated = (await diary.state()).entries[0];
  expect(updated.pain).toBeNull();
  expect(updated.start).toBe(original.start);
});

test('补充症状：未知与明确无症状分开；关闭取消不改数据', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByRole('button', { name: '怕光', exact: true }).click();
  await page.getByLabel('想补充的话（可选）').fill('想保留的中文备注 <测试>');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const beforeCancel = await diary.state();
  expect(beforeCancel.entries[0].symptoms).toEqual(['怕光']);
  expect(beforeCancel.entries[0].endUnknown).toBe(true);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByRole('button', { name: '无伴随症状', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(await diary.state()).toEqual(beforeCancel);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByRole('button', { name: '无伴随症状', exact: true }).click();
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).entries[0].symptoms).toEqual([]);
});

test('回忆起真实时间后可补全；结束早于开始会留在表单报错', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  const before = await diary.state();
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByText('补充或修改时间（可选）', { exact: true }).click();
  await page.getByLabel('开始时间准确程度').selectOption('approximate');
  const now = Date.now();
  await page.getByLabel('头痛开始时间').fill(localValue(new Date(now - 3600000)));
  await page.getByLabel('结束情况').selectOption('ended');
  await page.getByLabel('头痛结束时间').fill(localValue(new Date(now - 7200000)));
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  expect(await diary.state()).toEqual(before);
  await page.getByLabel('头痛结束时间').fill(localValue(new Date(now - 1800000)));
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const entry = (await diary.state()).entries[0];
  expect(entry.onsetPrecision).toBe('approximate');
  expect(entry.endUnknown).toBe(false);
  expect(Date.parse(entry.end) - Date.parse(entry.start)).toBe(1800000);
});

test('实际用药需要确认；常用药减少输入；编辑不改原服药秒数', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  await page.getByRole('button', { name: '记录用药', exact: true }).click();
  expect((await diary.state()).entries[0].medications).toEqual([]);
  await page.getByLabel('实际药名').fill('测试药（非处方）');
  await page.getByLabel('实际剂量（可选）').fill('测试剂量');
  await page.getByRole('button', { name: '确认实际服药并保存' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const first = (await diary.state()).entries[0].medications[0];
  await page.getByRole('button', { name: '记录用药', exact: true }).click();
  await page.getByRole('button', { name: '测试药（非处方） · 测试剂量', exact: true }).click();
  await expect(page.getByLabel('实际药名')).toHaveValue(first.name);
  await expect(page.getByLabel('实际剂量（可选）')).toHaveValue(first.dose);
  expect((await diary.state()).entries[0].medications).toHaveLength(1);
  await page.getByRole('button', { name: '确认实际服药并保存' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).entries[0].medications).toHaveLength(2);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByRole('button', { name: '保存并修改', exact: true }).first().click();
  await page.getByLabel('这次用药的缓解情况（可之后补）').selectOption('partial');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const updated = (await diary.state()).entries[0].medications[0];
  expect(updated.at).toBe(first.at);
  expect(updated.relief).toBe('partial');
});

test('已结束发作的新用药默认当前服药时间，不能冒充结束时服过', async ({ patient: page, diary }) => {
  const entry=await seedExact(diary);
  await page.reload();
  await page.getByRole('button', { name: '记录用药', exact: true }).click();
  await expect(page.getByLabel('实际服药时间')).toHaveValue(localValue(new Date()));
  expect(entry.id).toBe((await diary.state()).entries[0].id);
});

test('连续真实双击只产生一次PUT及一条记录', async ({ patient: page, diary }) => {
  let writes=0;
  await page.route('**/api/state', async route => {
    if (route.request().method()==='PUT') {writes++;await new Promise(resolve=>setTimeout(resolve,250));}
    await route.continue();
  });
  await page.getByTestId('record-headache').dblclick({ delay: 10 });
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  await expect.poll(async ()=>(await diary.state()).entries.length).toBe(1);
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect(page.locator('#save-error')).not.toBeVisible();
  expect(writes).toBe(1);
  expect((await diary.diskState()).revision).toBe(1);
});

test('一次点击遇到真实版本冲突自动重试，保留另一窗口记录',async({patient:page,diary})=>{
  const other=await seedExact(diary,{id:'other-window-entry',notes:'另一窗口已存内容'});
  const revisions=[];
  await page.route('**/api/state',async route=>{
    if(route.request().method()==='PUT')revisions.push(route.request().postDataJSON().expectedRevision);
    await route.continue();
  });
  const recorded=await recordOnce(page,diary);
  const saved=await diary.diskState();
  expect(revisions).toEqual([0,1]);
  expect(saved.entries).toHaveLength(2);
  expect(saved.entries.find(entry=>entry.id===other.id)).toEqual(other);
  expect(recorded.statusUnknown).toBe(true);
  await expect(page.locator('#save-error')).not.toBeVisible();
});

test('持续版本冲突最多三次PUT尝试，失败不假装保存也不无限重试',async({patient:page,diary})=>{
  const before=await diary.state();
  let attempts=0;
  await page.route('**/api/state',route=>{
    if(route.request().method()!=='PUT')return route.continue();
    attempts++;
    return route.fulfill({status:409,contentType:'application/json',body:'{"error":"验收：另一窗口连续更新"}'});
  });
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('record-headache')).toBeEnabled();
  expect(attempts).toBe(3);
  expect(await diary.state()).toEqual(before);
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await expect(page.locator('#save-status')).not.toHaveText('已保存');
});

test('主记录写盘失败保持同一记录ID，恢复后一次点击重试成功',async({patient:page,diary})=>{
  let submitted;
  await page.route('**/api/state',route=>{
    if(route.request().method()!=='PUT')return route.continue();
    submitted=route.request().postDataJSON().state.entries.at(-1);
    return route.fulfill({status:503,contentType:'application/json',body:'{"error":"验收：磁盘暂不可用"}'});
  });
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('alert')).toContainText('磁盘暂不可用');
  expect((await diary.state()).entries).toEqual([]);
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await page.unroute('**/api/state');
  const saved=await recordOnce(page,diary);
  expect(saved.id).toBe(submitted.id);
  expect(saved.createdAt).toBe(submitted.createdAt);
  expect((await diary.diskState()).entries).toHaveLength(1);
});

test('已存A后记录B等待或失败时隐藏旧成功提示，重试只保存正确的第二条',async({patient:page,diary})=>{
  const first=await recordOnce(page,diary);
  let release, secondId;
  const hold=new Promise(resolve=>release=resolve);
  await page.route('**/api/state',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    secondId=route.request().postDataJSON().state.entries.at(-1).id;
    await hold;
    await route.fulfill({status:503,contentType:'application/json',body:'{"error":"验收：第二条保存暂失败"}'});
  });
  await page.getByTestId('record-headache').click();
  await expect(page.getByTestId('record-headache')).toBeDisabled();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await expect(page.getByText('可以直接关闭窗口，先休息。',{exact:true})).not.toBeVisible();
  expect((await diary.diskState()).entries.map(entry=>entry.id)).toEqual([first.id]);
  release();
  await expect(page.getByRole('alert')).toContainText('第二条保存暂失败');
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await expect(page.getByText('可以直接关闭窗口，先休息。',{exact:true})).not.toBeVisible();
  expect((await diary.diskState()).entries.map(entry=>entry.id)).toEqual([first.id]);
  await page.unroute('**/api/state');
  const second=await recordOnce(page,diary);
  expect(second.id).toBe(secondId);
  expect(second.id).not.toBe(first.id);
  const saved=await diary.diskState();
  expect(saved.entries.map(entry=>entry.id)).toEqual([first.id,secondId]);
  expect(saved.entries[0]).toEqual(first);
  await expect(page.getByText('可以直接关闭窗口，先休息。',{exact:true})).toBeVisible();
});

test('删除仅日期记录的确认只显示日期，不把午夜占位显示成真实起始时刻',async({patient:page,diary})=>{
  const entry=await recordOnce(page,diary);
  const before=await diary.diskState();
  const date=await page.evaluate(value=>new Date(value).toLocaleDateString('sv-SE'),entry.start);
  await page.getByRole('button',{name:'补时间或症状',exact:true}).click();
  await page.getByRole('button',{name:'删除记录',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText(date);
  await expect(dialog).not.toContainText('00:00');
  await page.getByRole('button',{name:'保留记录',exact:true}).click();
  expect(await diary.diskState()).toEqual(before);
});

test('服务器已保存但响应丢失，重试确认同一记录不会再创建或重复写盘',async({patient:page,diary})=>{
  await page.route('**/api/state',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('alert')).toBeVisible();
  const stored=await diary.diskState();
  expect(stored.entries).toHaveLength(1);
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  await page.unroute('**/api/state');
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  expect(await diary.diskState()).toEqual(stored);
  await expect(page.locator('#save-error')).not.toBeVisible();
});

test('补真实开始时间必须主动确认结束情况，不能从一次记录推断已结束',async({patient:page,diary})=>{
  await recordOnce(page,diary);
  const before=await diary.state();
  await page.getByRole('button',{name:'补时间或症状',exact:true}).click();
  await page.getByText('补充或修改时间（可选）',{exact:true}).click();
  await expect(page.getByLabel('结束情况')).toHaveValue('unrecorded');
  await page.getByLabel('开始时间准确程度').selectOption('approximate');
  await page.getByLabel('头痛开始时间').fill(localValue(new Date(Date.now()-3600000)));
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('请选择结束情况');
  expect(await diary.state()).toEqual(before);
  await page.getByLabel('结束情况').selectOption('unknown');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved=(await diary.diskState()).entries[0];
  expect(saved.statusUnknown).not.toBe(true);
  expect(saved.endUnknown).toBe(true);
  expect(saved.end).toBeNull();
});

test('记录写盘等待期间主操作禁用，不提前声称保存成功', async ({ patient: page, diary }) => {
  let release;
  const hold=new Promise(resolve=>release=resolve);
  await page.route('**/api/state', async route=>{
    if(route.request().method()==='PUT')await hold;
    await route.continue();
  });
  await page.getByTestId('record-headache').click();
  await expect(page.getByTestId('record-headache')).toBeDisabled();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).not.toBeVisible();
  expect((await diary.state()).entries).toEqual([]);
  release();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect(page.locator('#save-error')).not.toBeVisible();
  expect((await diary.diskState()).revision).toBe(1);
});

test('排队保存保留本次点击时间，记录不假设为头痛开始时间', async ({ patient: page, diary }) => {
  let requests = 0;
  await page.route('**/api/state', async route => {
    if (route.request().method()==='PUT' && ++requests===1) await new Promise(resolve=>setTimeout(resolve,800));
    await route.continue();
  });
  await page.getByRole('button', { name: '切换明亮模式' }).click();
  await recordOnce(page, diary);
  const clickedAt = (await confirmedTiming(page)).clickWallTime;
  const entry = (await diary.state()).entries[0];
  expect(Math.abs(Date.parse(entry.createdAt) - clickedAt)).toBeLessThan(200);
  expect(entry.onsetPrecision).toBe('day');
  expect(entry.statusUnknown).toBe(true);
});

test('保存失败有持续未保存提示；恢复后重试不会虚构成功', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  await page.route('**/api/state', route => route.request().method()==='PUT'
    ? route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({error:'验收模拟：磁盘暂不可用'}) }) : route.continue());
  const before = await diary.state();
  await page.getByRole('button', { name: '重度 8 / 10 分' }).click();
  await expect(page.getByRole('alert')).toContainText('未保存');
  await expect(page.locator('#save-status')).not.toHaveText('已保存');
  expect(await diary.state()).toEqual(before);
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: '重度 8 / 10 分' }).click();
  await expect(page.getByRole('button', { name: '重度 8 / 10 分' })).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#save-status')).toHaveText('已保存');
  await expect(page.getByRole('alert')).not.toBeVisible();
});

test('表单保存断网后保留已填内容并可重试', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByLabel('想补充的话（可选）').fill('断网时不能丢的备注');
  await page.route('**/api/state', route => route.request().method()==='PUT' ? route.abort('failed') : route.continue());
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('保存未确认');
  await expect(page.getByLabel('想补充的话（可选）')).toHaveValue('断网时不能丢的备注');
  await page.unroute('**/api/state');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).entries[0].notes).toBe('断网时不能丢的备注');
});

test('多窗口冲突不覆盖别人记录，原表单内容留给患者重试', async ({ patient: page, diary, context }) => {
  await recordOnce(page, diary);
  const other = await context.newPage();
  await other.goto(diary.url);
  await page.getByRole('button', { name: '补时间或症状' }).click();
  await page.getByLabel('想补充的话（可选）').fill('窗口甲的备注');
  await other.getByRole('button',{name:'补时间或症状',exact:true}).click();
  await other.getByLabel('这次最痛时（0–10 分，可不填）').fill('8');
  await other.getByTestId('save-entry').click();
  await expect(other.getByRole('dialog')).not.toBeVisible();
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('另一窗口');
  await expect(page.getByLabel('想补充的话（可选）')).toHaveValue('窗口甲的备注');
  expect((await diary.state()).entries[0].pain).toBe(8);
  expect((await diary.state()).entries[0].notes).toBe('');
  // A retry must not silently replace the other window's pain with the old empty field.
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved = (await diary.state()).entries[0];
  expect(saved.notes).toBe('窗口甲的备注');
  expect(saved.pain).toBe(8);
});

test('无头痛标记被新发作替代，未记录日期保持未知', async ({ patient: page, diary }) => {
  await page.getByRole('button', { name:'今天没有头痛', exact:true }).click();
  await expect(page.getByRole('button', { name:'今天已记为无头痛' })).toBeDisabled();
  expect((await diary.state()).days).toHaveLength(1);
  await recordOnce(page, diary);
  expect((await diary.state()).days).toEqual([]);
  await nav(page, '报告');
  await expect(page.locator('.summary-note')).toContainText('27 天未记录');
});

test('真正下载HTML、CSV及JSON；中文、原始记录与统计一致', async ({ patient: page, diary }, info) => {
  await recordOnce(page, diary);
  await page.getByRole('button', { name:'补时间或症状' }).click();
  await page.getByLabel('想补充的话（可选）').fill('中文,备注 <特殊字符>');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await nav(page, '报告');
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name:'导出 CSV 明细' }).click();
  const csv = await csvEvent;
  const csvPath = info.outputPath('actual-download.csv');
  await csv.saveAs(csvPath);
  const csvText = await fs.readFile(csvPath,'utf8');
  expect(csvText.charCodeAt(0)).toBe(0xFEFF);
  expect(csvText).toContain('中文,备注 <特殊字符>');
  await page.getByRole('button', { name:'预览就诊报告' }).click();
  const reportEvent = page.waitForEvent('download');
  await page.getByRole('button', { name:'下载 HTML 报告' }).click();
  const report = await reportEvent;
  const reportPath = info.outputPath('actual-report.html');
  await report.saveAs(reportPath);
  const reportText = await fs.readFile(reportPath,'utf8');
  expect(reportText).toContain('中文,备注 &lt;特殊字符&gt;');
  expect(reportText).not.toMatch(/<script\b/i);
  await page.getByRole('button', { name:'关闭窗口' }).click();
  await nav(page, '数据');
  const backupEvent = page.waitForEvent('download');
  await page.getByRole('button', { name:'下载备份' }).click();
  const backup = await backupEvent;
  const backupPath = info.outputPath('actual-backup.json');
  await backup.saveAs(backupPath);
  expect(JSON.parse(await fs.readFile(backupPath,'utf8'))).toEqual(await diary.state());
});

test('恢复备份先预览，取消安全，写入失败后可直接重试', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  const before = await diary.state();
  const restored = emptyState(); restored.profile.name='恢复验收患者';
  await nav(page, '数据');
  const upload = () => page.locator('#backup-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(restored))});
  await upload();
  await expect(page.getByRole('heading', {name:'确认恢复这份备份'})).toBeVisible();
  expect(await diary.state()).toEqual(before);
  await page.getByRole('button', {name:'取消',exact:true}).click();
  expect(await diary.state()).toEqual(before);
  await upload();
  await page.route('**/api/state', route => route.request().method()==='PUT' ? route.fulfill({status:503,contentType:'application/json',body:'{"error":"模拟写盘失败"}'}) : route.continue());
  await page.getByRole('button', {name:'确认替换并恢复'}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('模拟写盘失败');
  expect(await diary.state()).toEqual(before);
  await page.unroute('**/api/state');
  await page.getByRole('button', {name:'确认替换并恢复'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).profile.name).toBe('恢复验收患者');
  expect((await diary.state()).entries).toEqual([]);
  const backups = await fs.readdir(`${diary.directory}/backups`);
  const snapshots = await Promise.all(backups.map(name=>fs.readFile(`${diary.directory}/backups/${name}`,'utf8').then(JSON.parse)));
  expect(snapshots.some(snapshot=>snapshot.entries[0]?.id===before.entries[0].id)).toBe(true);
});

test('无效备份拒绝导入；示例模式不污染真实记录', async ({ patient: page, diary }) => {
  await recordOnce(page, diary);
  const before = await diary.state();
  await nav(page, '数据');
  await page.locator('#backup-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"schemaVersion":99}')});
  await expect(page.locator('#toast')).toContainText('未导入');
  expect(await diary.state()).toEqual(before);
  await page.getByRole('button', {name:'看看示例',exact:true}).click();
  await nav(page, '记录');
  await page.getByTestId('record-headache').click();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  expect(await diary.state()).toEqual(before);
  await page.getByRole('button', {name:/回到我的日记/}).click();
  await expect(page.getByTestId('record-headache')).toBeVisible();
  expect(await diary.state()).toEqual(before);
});

test('服务停止重开仍读到原记录；无需互联网请求', async ({ patient: page, diary }) => {
  const external = [];
  page.on('request', request=>{if(!request.url().startsWith(diary.url))external.push(request.url());});
  await recordOnce(page, diary);
  const before = await diary.state();
  await diary.stop();
  await diary.start();
  await page.reload();
  await expect(page.getByTestId('record-headache')).toBeVisible();
  expect(await diary.state()).toEqual(before);
  expect(external).toEqual([]);
});

test('键盘一次Enter可记录、Escape可退出可选弹窗；暗色偏好重开保留', async ({ patient: page, diary }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByTestId('record-headache').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  await page.getByRole('button', { name:'记录用药',exact:true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', {name:'切换明亮模式'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.getByRole('button', {name:'切换暗色模式'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect((await diary.state()).profile.theme).toBe('dark');
});

test('常用入口大于44px，无横向溢出；记录页主操作不用滚动', async ({ patient: page }, info) => {
  const viewport = page.viewportSize();
  for(const locator of [page.getByTestId('record-headache')]) {
    const box = await locator.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(80);
    expect(box.y+box.height).toBeLessThan(viewport.height-78);
  }
  await expect(page.locator('.record-actions button')).toHaveCount(1);
  for(const name of ['记录','历史','报告','数据']) {
    await nav(page,name);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} has no horizontal scrolling`).toBe(true);
    const buttons=await page.getByRole('navigation').getByRole('button').all();
    for(const button of buttons) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  await nav(page,'记录');
  await page.screenshot({path:info.outputPath('patient-home.png')});
});

test('320px窄窗口与200%显示密度仍能记录和保存表单', async ({ patient: page, diary, browser }) => {
  await page.setViewportSize({width:320,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await recordOnce(page,diary);
  await page.getByRole('button',{name:'补时间或症状'}).click();
  await page.getByLabel('想补充的话（可选）').fill('大字号验收');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).entries[0].notes).toBe('大字号验收');
  // A physical 1280x900 window with 2x rendering and a 640x450 CSS viewport.
  // CSS body.zoom would leave dvh unchanged, so it is not browser zoom emulation.
  const enlarged=await browser.newContext({viewport:{width:640,height:450},deviceScaleFactor:2,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'});
  const zoomed=await enlarged.newPage();
  await zoomed.goto(diary.url);
  expect(await zoomed.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await zoomed.getByRole('button',{name:'补时间或症状'}).click();
  await zoomed.getByLabel('想补充的话（可选）').fill('200%缩放验收');
  await zoomed.getByTestId('save-entry').click();
  await expect(zoomed.getByRole('dialog')).not.toBeVisible();
  expect((await diary.state()).entries[0].notes).toBe('200%缩放验收');
  await enlarged.close();
});

test('旧读取晚到不能撤销单次点击已经保存的头痛记录',async({patient:page,diary})=>{
  let releaseRead,readReady;
  const hold=new Promise(resolve=>releaseRead=resolve);
  const ready=new Promise(resolve=>readReady=resolve);
  let intercepted=false;
  await page.route('**/api/state',async route=>{
    if(route.request().method()==='GET'&&!intercepted){
      intercepted=true;
      const old=await route.fetch();
      const body=await old.json();
      readReady();
      await hold;
      await route.fulfill({json:body});
    }else await route.continue();
  });
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await ready;
  await recordOnce(page,diary);
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  const responseEvent=page.waitForResponse(response=>response.url().endsWith('/api/state')&&response.request().method()==='GET');
  releaseRead();
  await (await responseEvent).finished();
  // Wait for the old GET body to have been consumed and render's load path completed.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.locator('[data-action="start"],[data-action="stop"]')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  expect((await diary.diskState()).entries).toHaveLength(1);
});

test('畏光：首屏即暗色、无白色闪屏，按钮即时显示保存反馈',async({page,diary})=>{
  await page.route('**/styles.css',route=>route.abort());
  await page.route('**/app.js',route=>route.abort());
  await page.goto(diary.url);
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
  expect(await page.locator('html').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(23, 29, 25)');
  await page.unroute('**/styles.css');
  await page.unroute('**/app.js');
  await page.reload();
  await expect(page.getByTestId('record-headache')).toBeVisible();
  let release;
  const hold=new Promise(resolve=>release=resolve);
  await page.route('**/api/state',async route=>{if(route.request().method()==='PUT')await hold;await route.continue();});
  await page.getByTestId('record-headache').click();
  await expect(page.getByTestId('record-headache')).toBeDisabled();
  await expect(page.getByTestId('record-headache')).toContainText('正在保存');
  release();
  await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('导入的自定义症状及明确空字段，补写备注时完整保留',async({patient:page,diary})=>{
  await recordOnce(page,diary);
  const imported=await diary.state();
  Object.assign(imported.entries[0],{symptoms:['自定义伴随症状'],locations:[],character:[],triggers:[]});
  await diary.seed(imported);
  await page.reload();
  await page.getByRole('button',{name:'补时间或症状'}).click();
  await expect(page.getByRole('button',{name:'自定义伴随症状',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByLabel('想补充的话（可选）').fill('只补写备注');
  await page.getByTestId('save-entry').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved=(await diary.state()).entries[0];
  expect(saved.symptoms).toEqual(['自定义伴随症状']);
  expect(saved.locations).toEqual([]);
  expect(saved.character).toEqual([]);
  expect(saved.triggers).toEqual([]);
  expect(saved.notes).toBe('只补写备注');
});

import { test, expect, nav, emptyState, confirmedTiming, installTiming } from './fixtures.js';
import { promises as fs } from 'node:fs';

test('30轮单次真实点击保存耗时：包含strong和span命中，不需要结束操作', async ({ patient:page,diary },info)=>{
  test.setTimeout(90000);
  const samples={oneTap:[]};
  let writes=0;
  page.on('request',request=>{if(request.url().endsWith('/api/state')&&request.method()==='PUT')writes++;});
  for(let i=0;i<30;i++){
    if(i)await page.reload();
    await expect(page.getByTestId('record-headache')).toBeVisible();
    await installTiming(page);
    await page.getByTestId('record-headache').locator(i%2?'span':'strong').click();
    await expect(page.getByRole('heading',{name:'这次头痛已记录',exact:true})).toBeVisible();
    samples.oneTap.push((await confirmedTiming(page)).confirmedMs);
    const saved=await diary.diskState();
    expect(saved.entries).toHaveLength(i+1);
    expect(saved.entries[i].onsetPrecision).toBe('day');
    expect(saved.entries[i].statusUnknown).toBe(true);
    expect(saved.entries[i].end).toBeNull();
    await expect(page.locator('[data-action="start"],[data-action="stop"]')).toHaveCount(0);
  }
  expect(writes).toBe(30);
  const stats={};
  for(const [key,values] of Object.entries(samples)){
    const ordered=[...values].sort((a,b)=>a-b);
    const middle=Math.floor(values.length/2);
    stats[key]={n:values.length,medianMs:values.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2,p95Ms:ordered[Math.ceil(values.length*.95)-1],maxMs:ordered.at(-1)};
    expect(stats[key].p95Ms,`${key} 95% confirmed within 1 second`).toBeLessThan(1000);
    expect(stats[key].maxMs,`${key} worst confirmed within 1.5 seconds`).toBeLessThan(1500);
  }
  await fs.writeFile(info.outputPath('latency.json'),JSON.stringify({stats,samples,clicks:30,successfulWrites:writes},null,2));
  await info.attach('latency.json',{body:JSON.stringify({stats,samples,clicks:30,successfulWrites:writes}),contentType:'application/json'});
});

test('A4 PDF打印布局：三份4000字备注、多页明细和页尾均可输出', async ({patient:page,diary,context},info)=>{
  test.skip(info.project.name!=='Edge-desktop','Print layout is independent of viewport');
  const now=Date.now();
  const stamp=new Date(now).toISOString();
  const data=emptyState();
  data.profile.name='PDF验收用虚拟患者';
  for(let i=0;i<3;i++)data.entries.push({
    id:`pdf-${i}`,start:new Date(now-(i+1)*86400000-3600000).toISOString(),end:new Date(now-(i+1)*86400000).toISOString(),endUnknown:false,onsetPrecision:'exact',pain:i+3,symptoms:['怕光','恶心'],locations:['左侧'],character:['搏动 / 跳痛'],triggers:null,impact:'reduced',menstruation:null,
    notes:`PDF_BEGIN_${i}\n`+'这是实际分页验收备注。'.repeat(380).slice(0,3950)+`\nPDF_END_${i}`,medications:[{id:`dose-${i}`,name:'测试药名，仅用于软件验收',dose:'测试剂量',at:new Date(now-(i+1)*86400000-1800000).toISOString(),relief:'partial'}],createdAt:stamp,updatedAt:stamp,
  });
  await diary.seed(data);
  await page.reload();
  await nav(page,'报告');
  await page.getByRole('button',{name:'预览就诊报告'}).click();
  const report = page.frameLocator('#report-frame').locator('body');
  await expect(report).toContainText('PDF_END_0');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载 HTML 报告'}).click();
  const download=await downloadEvent;
  const sourcePath=info.outputPath('print-source.html');
  await download.saveAs(sourcePath);
  const printPage=await context.newPage();
  await printPage.setContent(await fs.readFile(sourcePath,'utf8'));
  await printPage.evaluate(()=>document.fonts.ready);
  await printPage.emulateMedia({media:'print'});
  const pdf=await printPage.pdf({path:info.outputPath('doctor-report-a4.pdf'),format:'A4',printBackground:true});
  expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(10000);
  await info.attach('doctor-report-a4.pdf',{body:pdf,contentType:'application/pdf'});
  await printPage.close();
});

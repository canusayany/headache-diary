import { test, expect, recordOnce } from './fixtures.js';

test.use({ serviceWorkers: 'allow' });

test('真实Service Worker只缓存界面；服务不可达明确失败，恢复后原记录仍在',async({patient:page,diary,context})=>{
  const entry=await recordOnce(page,diary);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
  const cached=await page.evaluate(async()=>{
    const keys=await caches.keys();
    const urls=[];
    for(const key of keys)for(const request of await (await caches.open(key)).keys())urls.push(request.url);
    return urls;
  });
  expect(cached.some(url=>url.endsWith('/app.js'))).toBe(true);
  expect(cached.some(url=>url.includes('/api/'))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading',{name:'记录仍留在你的电脑上'})).toBeVisible();
  await expect(page.getByTestId('record-headache')).not.toBeVisible();
  await expect(page.locator('#save-status')).not.toHaveText('已保存');
  await context.setOffline(false);
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(page.getByTestId('record-headache')).toBeVisible();
  await expect(page.locator('[data-action="start"],[data-action="stop"]')).toHaveCount(0);
  expect((await diary.state()).entries[0].id).toBe(entry.id);
});

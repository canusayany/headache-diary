// Offline, shared rendering for the app and the printable doctor report.
// Counts are diary records by onset/known date; continuing days are not new attacks.
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const monthLabel=month=>`${Number(month.slice(0,4))}年${Number(month.slice(5))}月`;
const safeCount=value=>Number.isSafeInteger(value)&&value>=0?value:0;

export function dayChartLabel(day){
  if(day.status==='unknown')return `${day.date}，未记录，头痛次数未知`;
  if(day.status==='no-headache')return `${day.date}，已确认无头痛，0次`;
  const count=safeCount(day.recordCount),carry=safeCount(day.carryoverCount);
  return `${day.date}，有头痛，${count}次当天记录${carry?`，${carry}条由更早日期延续`:''}`;
}

export function dailyHeadacheChart(summary,{interactive=false,selectedDate=null,calendarPage=0}={}){
  const allMonths=[...new Set(summary.dayDetails.map(day=>day.date.slice(0,7)))];
  const pageSize=interactive?12:allMonths.length;
  const pageCount=Math.max(1,Math.ceil(allMonths.length/pageSize));
  const pageIndex=Math.max(0,Math.min(pageCount-1,safeCount(calendarPage)));
  const months=interactive?allMonths.slice(pageIndex*pageSize,(pageIndex+1)*pageSize):allMonths;
  const calendars=months.map(month=>{
    const rangeDays=summary.dayDetails.filter(day=>day.date.startsWith(month));
    const first=new Date(`${rangeDays[0].date}T12:00:00`);
    const padding=(first.getDay()+6)%7;
    const cells=rangeDays.map(day=>{
      const date=day.date,dateNumber=Number(date.slice(-2));
      const count=safeCount(day.recordCount),carry=safeCount(day.carryoverCount);
      const value=day.status==='unknown'?'?':day.status==='no-headache'?'无':count?`${count}<small>次</small>`:'延续';
      const extra=carry&&count?'<span class="hc-carry">+延续</span>':'';
      const attributes=`class="hc-day hc-${day.status}${selectedDate===date?' hc-selected':''}" data-date="${date}" data-status="${day.status}" data-record-count="${count}" data-carryover-count="${carry}" aria-label="${esc(dayChartLabel(day))}"`;
      const countSize=count>=100?' hc-large-count hc-count-'+String(count).length:'';
      const content=`<span class="hc-date">${dateNumber}</span><span class="hc-value${countSize}">${value}</span>${extra}`;
      return interactive?`<button type="button" ${attributes} data-action="report-day" aria-pressed="${selectedDate===date}" title="${esc(dayChartLabel(day))}">${content}</button>`:`<div ${attributes}>${content}</div>`;
    }).join('');
    return `<section class="hc-calendar-month"><h3>${monthLabel(month)}</h3><p class="hc-month-range">${rangeDays[0].date.slice(5)} 至 ${rangeDays.at(-1).date.slice(5)}</p><div class="hc-week" aria-hidden="true">${['一','二','三','四','五','六','日'].map(label=>`<span>${label}</span>`).join('')}</div><div class="hc-calendar" role="group" aria-label="${monthLabel(month)}每日头痛记录">${'<span aria-hidden="true"></span>'.repeat(padding)}${cells}</div></section>`;
  }).join('');
  const navigation=pageCount>1?`<nav class="hc-navigation" tabindex="-1" aria-label="日历分页，第${pageIndex+1}/${pageCount}组"><button type="button" data-action="report-calendar-page" data-value="${pageIndex-1}" ${pageIndex===0?'disabled':''}>上一组月份</button><span>第${pageIndex+1}/${pageCount}组 · 日历每组最多12个月<br>月度统计和导出包含全部所选日期</span><button type="button" data-action="report-calendar-page" data-value="${pageIndex+1}" ${pageIndex===pageCount-1?'disabled':''}>下一组月份</button></nav>`:'';
  return `<section class="hc-panel" data-testid="daily-headache-chart"><div class="hc-heading"><h2>每日头痛记录</h2><span>${summary.fromDay} 至 ${summary.toDay}</span></div><p class="hc-intro">有头痛的日期显示次数。${interactive?'点日期查看当天明细。':'格内数字为当天新记的次数。'}</p><div class="hc-legend"><span><i class="hc-key-pain"></i>数字：当天记录次数</span><span><i class="hc-key-free"></i>无：已确认无头痛</span><span><i class="hc-key-unknown"></i>?：未记录</span><span>延续：由更早日期开始的记录</span></div>${navigation}<div class="hc-month-grid">${calendars}</div><p class="hc-footnote">每条记录按开始日期或已知头痛日期计1次；同一天多条分别计数。跨日延续仍算有头痛的日期，次数只计在开始日。未记录不能当作无头痛。</p></section>`;
}

export function monthlyHeadacheChart(summary){
  const monthly=summary.monthly;
  const maximum=Math.max(1,...monthly.map(month=>safeCount(month.recordCount)));
  // Use a shared zero origin and scale, with integer ticks, across all printed chunks.
  const tickStep=Math.max(1,Math.ceil(maximum/4));
  const scaleMax=Math.ceil(maximum/tickStep)*tickStep;
  const left=124,width=330,right=118,rowHeight=64,top=38;
  const chunks=[];
  for(let i=0;i<monthly.length;i+=6){
    const rows=monthly.slice(i,i+6),height=top+rows.length*rowHeight+32;
    const ticks=Array.from({length:scaleMax/tickStep+1},(_,index)=>index*tickStep);
    const axes=ticks.map(value=>{const x=left+value/scaleMax*width;return `<line class="hc-gridline" x1="${x}" x2="${x}" y1="28" y2="${height-28}"/><text class="hc-axis-text" x="${x}" y="18" text-anchor="middle">${value}</text>`;}).join('');
    const bars=rows.map((month,index)=>{
      const count=safeCount(month.recordCount),y=top+index*rowHeight;
      const missing=month.confirmedDays===0;
      const partial=month.partialMonth?'部分月':'整月';
      const label=`${monthLabel(month.month)}，${missing?'未记录':count+'次头痛记录'}，有头痛${month.headacheDays}天，未记录${month.unknownDays}天，${partial}，${month.fromDay}至${month.toDay}`;
      const barWidth=count/scaleMax*width;
      const valueText=missing?'未记录':`${count} 次`;
      return `<g data-month="${month.month}" data-record-count="${count}" data-headache-days="${month.headacheDays}" data-unknown-days="${month.unknownDays}" data-partial-month="${Boolean(month.partialMonth)}" aria-label="${esc(label)}"><title>${esc(label)}</title><text class="hc-month-label" x="0" y="${y+14}">${monthLabel(month.month)}</text><text class="hc-meta" x="0" y="${y+33}">${partial} · ${month.totalDays}天</text>${barWidth?`<rect class="hc-bar" x="${left}" y="${y}" width="${barWidth}" height="24" rx="2"/>`:`<line class="hc-zero ${missing?'hc-missing-mark':''}" x1="${left}" x2="${left+7}" y1="${y+12}" y2="${y+12}"/>`}<text class="hc-bar-value" x="${left+barWidth+10}" y="${y+18}">${valueText}</text><text class="hc-meta" x="${left}" y="${y+43}">头痛 ${month.headacheDays} 天 · 未记录 ${month.unknownDays} 天</text></g>`;
    }).join('');
    chunks.push(`<div class="hc-svg-wrap"><svg xmlns="http://www.w3.org/2000/svg" class="hc-monthly-svg" viewBox="0 0 ${left+width+right} ${height}" role="img" aria-label="每月头痛记录次数，从零开始的柱状图；次数、头痛天数和未记录天数见每月标签"><title>每月头痛次数（按记录）</title><desc>${esc(rows.map(month=>`${monthLabel(month.month)}：${month.confirmedDays===0?'未记录':month.recordCount+'次记录'}；头痛${month.headacheDays}天；未记录${month.unknownDays}天；${month.partialMonth?'部分月':'整月'}`).join('。'))}</desc>${axes}${bars}</svg></div>`);
  }
  const table=`<details class="hc-data-table"><summary>查看每月数字明细</summary><div class="hc-table-wrap"><table><caption>每月头痛记录次数及统计覆盖</caption><thead><tr><th scope="col">月份</th><th scope="col">记录次数</th><th scope="col">头痛天数</th><th scope="col">未记录天数</th><th scope="col">统计覆盖</th></tr></thead><tbody>${monthly.map(month=>`<tr><th scope="row">${month.month}</th><td>${month.confirmedDays===0?'未记录':month.recordCount+'次'}</td><td>${month.headacheDays}天</td><td>${month.unknownDays}天</td><td>${month.fromDay} 至 ${month.toDay}（${month.partialMonth?'部分月':'整月'}）</td></tr>`).join('')}</tbody></table></div></details>`;
  return `<section class="hc-panel" data-testid="monthly-headache-chart"><div class="hc-heading"><h2>每月头痛次数</h2><span>按记录 · 单位：次</span></div><p class="hc-intro">本时段共记录 <strong>${summary.recordCount} 次</strong>，涉及 <strong>${summary.headacheDays} 天</strong>有头痛。</p>${chunks.join('')}${table}<p class="hc-footnote">包括只记日期的记录。次数和头痛天数分开统计；未记录天数较多时，次数可能低估。部分月只统计所选日期，不外推整月，也不自动判断偏头痛类型。</p></section>`;
}

export function reportCharts(summary,options={}){
  return `<div class="headache-charts">${monthlyHeadacheChart(summary)}${dailyHeadacheChart(summary,options)}</div>`;
}

export function chartStyles(){return `
.headache-charts{--hc-ink:var(--ink,#263b38);--hc-muted:var(--muted,#566a64);--hc-panel:var(--panel,#fff);--hc-line:var(--line,#c5d1cc);--hc-pain:#31665a;--hc-pain-bg:#e3eee9;--hc-pain-ink:#204c42;--hc-free-bg:#f3f6f4;--hc-free-ink:#3e554b;--hc-unknown-bg:#f4f4f1;color:var(--hc-ink);margin:24px 0}
.hc-panel{border:1px solid var(--hc-line);background:var(--hc-panel);border-radius:12px;padding:23px;margin:0 0 22px;min-width:0}
.hc-heading{display:flex;gap:12px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}.hc-heading h2{font-size:21px;margin:0}.hc-heading>span{font-size:13px;color:var(--hc-muted)}
.hc-intro{font-size:16px;line-height:1.7;margin:10px 0 16px;color:var(--hc-muted)}.hc-intro strong{color:var(--hc-ink)}.hc-footnote{font-size:13px;line-height:1.7;color:var(--hc-muted);margin:16px 0 0}
.hc-legend{display:flex;flex-wrap:wrap;gap:9px 18px;font-size:13px;line-height:1.6;margin:0 0 22px;color:var(--hc-muted)}.hc-legend>span{display:flex;align-items:center;gap:6px}.hc-legend i{display:inline-block;width:13px;height:13px;border:1px solid var(--hc-line);flex-shrink:0}.hc-key-pain{background:var(--hc-pain-bg);border-color:var(--hc-pain)!important}.hc-key-free{background:var(--hc-free-bg)}.hc-key-unknown{background:var(--hc-unknown-bg);border-style:dashed!important}
.hc-month-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.hc-calendar-month{min-width:0;break-inside:avoid}.hc-calendar-month h3{font-size:18px;margin:0 0 2px}.hc-month-range{font-size:12px;color:var(--hc-muted);margin:0 0 12px}.hc-week,.hc-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}.hc-week{font-size:12px;text-align:center;color:var(--hc-muted);margin-bottom:7px}.hc-day{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;min-height:68px;min-width:0;border:1px solid var(--hc-line);border-radius:6px;padding:6px 2px;font:inherit;color:var(--hc-ink);background:var(--hc-panel);line-height:1.35}.hc-date{font-size:12px;color:var(--hc-muted)}.hc-value{font-size:19px;font-weight:600;margin-top:5px;white-space:nowrap}.hc-value small{font-size:12px;font-weight:400;margin-left:2px}.hc-carry{font-size:10px;line-height:1.3;margin-top:3px}.hc-headache{background:var(--hc-pain-bg);border-color:var(--hc-pain);color:var(--hc-pain-ink)}.hc-headache .hc-date{color:var(--hc-pain-ink)}.hc-no-headache{background:var(--hc-free-bg);color:var(--hc-free-ink)}.hc-no-headache .hc-value{font-size:16px}.hc-unknown{border-style:dashed;background:var(--hc-unknown-bg)}.hc-unknown .hc-value{font-size:17px;color:var(--hc-muted)}.hc-outside{border-color:transparent;background:transparent;color:var(--hc-muted);opacity:.65}.hc-outside .hc-value{font-size:14px}.hc-selected{outline:3px solid var(--hc-pain);outline-offset:2px}.hc-day:focus-visible{outline:3px solid var(--hc-ink);outline-offset:2px}
.hc-svg-wrap{min-width:0;break-inside:avoid;margin:0 0 8px}.hc-monthly-svg{display:block;width:100%;height:auto;overflow:visible}.hc-monthly-svg text{font-family:inherit;fill:var(--hc-ink)}.hc-monthly-svg .hc-month-label{font-size:14px;font-weight:600}.hc-monthly-svg .hc-meta{font-size:12px;fill:var(--hc-muted)}.hc-monthly-svg .hc-axis-text{font-size:12px;fill:var(--hc-muted)}.hc-monthly-svg .hc-bar-value{font-size:15px;font-weight:600}.hc-gridline{stroke:var(--hc-line);stroke-width:1;stroke-dasharray:3 4}.hc-bar{fill:var(--hc-pain);stroke:var(--hc-pain);stroke-width:1}.hc-zero{stroke:var(--hc-muted);stroke-width:2}.hc-missing-mark{stroke-dasharray:2 2}
.hc-large-count small{display:block;margin:2px 0 0;font-size:10px;line-height:1}.hc-value.hc-count-3{font-size:15px}.hc-value.hc-count-4{font-size:12px}.hc-value.hc-count-5{font-size:9px}
.hc-navigation{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:16px 0 22px}.hc-navigation button{min-height:44px;padding:8px 12px;border:1px solid var(--hc-line);background:var(--hc-panel);color:var(--hc-ink);font:inherit;border-radius:6px}.hc-navigation span{font-size:12px;color:var(--hc-muted);line-height:1.7}
.hc-data-table{font-size:14px;margin-top:14px}.hc-data-table summary{min-height:44px;padding:10px 0;cursor:pointer}.hc-table-wrap{overflow-x:auto}.hc-data-table table{border-collapse:collapse;width:100%;font-size:13px}.hc-data-table th,.hc-data-table td{border:1px solid var(--hc-line);padding:9px;text-align:left;vertical-align:top}.hc-data-table caption{padding:8px;text-align:left;color:var(--hc-muted)}
[data-theme=dark] .headache-charts{--hc-pain:#96b4a5;--hc-pain-bg:#30463c;--hc-pain-ink:#dce9df;--hc-free-bg:#252d28;--hc-free-ink:#b9c7bf;--hc-unknown-bg:#1c231e}
.report-day-details{border:1px solid var(--line);border-radius:10px;padding:20px;margin:22px 0}.report-day-details h2{font-size:20px}.report-day-details>p{font-size:16px;color:var(--muted);margin:9px 0 14px}
@media(max-width:700px){.hc-month-grid{grid-template-columns:1fr}.hc-panel{padding:17px}.hc-heading h2{font-size:19px}.hc-heading>span{font-size:12px}.hc-svg-wrap{overflow-x:auto}.hc-monthly-svg{min-width:480px}.hc-day{min-height:68px}.hc-footnote{font-size:13px}}
@media(max-width:360px){.hc-calendar,.hc-week{gap:3px}.hc-panel{padding:12px}.hc-day{min-height:63px}.hc-value{font-size:17px}.hc-value small{font-size:10px}.hc-carry{font-size:9px}}
@media print{.headache-charts{--hc-ink:#17201c;--hc-muted:#303b35;--hc-panel:#fff;--hc-line:#c4cec8;--hc-pain:#315d51;--hc-pain-bg:#e8efeb;--hc-pain-ink:#183d31;--hc-free-bg:#f6f7f5;--hc-free-ink:#26372d;--hc-unknown-bg:#fff;margin:16px 0}.hc-panel{border-radius:0;padding:14px;margin-bottom:18px;break-inside:auto}.hc-heading h2{font-size:14pt}.hc-heading>span{font-size:9.5pt}.hc-intro{font-size:10.5pt;margin:8px 0 12px}.hc-legend{font-size:9.5pt;gap:7px 12px;margin-bottom:12px}.hc-footnote{font-size:9.5pt;line-height:1.6;margin-top:10px}.hc-month-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.hc-calendar-month h3{font-size:11pt}.hc-month-range{font-size:9pt}.hc-week{font-size:9pt}.hc-day{min-height:15mm;border-radius:0;padding:3px 1px}.hc-date{font-size:9pt}.hc-value{font-size:12pt;margin-top:3px}.hc-value small,.hc-carry{font-size:9pt}.hc-no-headache .hc-value,.hc-unknown .hc-value{font-size:11pt}.hc-outside .hc-value{font-size:9pt}.hc-value.hc-count-3{font-size:11pt}.hc-value.hc-count-4{font-size:10pt}.hc-value.hc-count-5{font-size:9pt}.hc-large-count small{font-size:9pt}.hc-svg-wrap{overflow:visible;break-inside:avoid}.hc-monthly-svg{min-width:0}.hc-data-table{display:none}.hc-calendar-month,.hc-heading{break-inside:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media print{.hc-panel[data-testid="daily-headache-chart"]{break-before:page}.hc-heading,.hc-intro,.hc-legend{break-after:avoid}.hc-navigation{display:none}}
`;}

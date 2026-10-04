import { summarize, formatDuration } from './model.js';
import { reportCharts, chartStyles } from './charts.js';

const MISSING = '未记录';
const labels = {
  normal: '基本照常', reduced: '活动减少', bedrest: '需要卧床',
  yes: '是', no: '否', unsure: '不确定',
  none: '无缓解', partial: '部分缓解', good: '明显缓解',
  headache: '有头痛', 'no-headache': '已确认无头痛', unknown: '未记录',
};

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function text(value) {
  if (value === null || value === undefined || value === '') return MISSING;
  return String(value);
}

function codedText(value) {
  if (value === null || value === undefined || value === '') return MISSING;
  return Object.hasOwn(labels, value) ? labels[value] : String(value);
}

function list(value) {
  if (!Array.isArray(value)) return MISSING;
  return value.length ? value.map(text).join('、') : '已确认无';
}

function validDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(value) {
  const date = validDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timestamp(value) {
  const date = validDate(value);
  if (!date) return MISSING;
  return `${dayKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function startText(entry, showApproximate = false) {
  if (entry.onsetPrecision === 'day' && entry.statusUnknown) return `${dayKey(entry.start)}（当天头痛已记录；起止时间未记录）`;
  if (entry.onsetPrecision === 'day') return `${dayKey(entry.start)}（已知有头痛；起止时间未记录）`;
  return `${timestamp(entry.start)}${showApproximate && entry.onsetPrecision === 'approximate' ? '（约）' : ''}`;
}

function csvStart(entry) {
  return entry.onsetPrecision === 'day' ? dayKey(entry.start) : timestamp(entry.start);
}

function precisionText(entry) {
  return entry.onsetPrecision === 'day' ? '仅日期' : entry.onsetPrecision === 'approximate' ? '约' : '准确';
}

function zoneLabel(now) {
  const date = validDate(now) ?? new Date();
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  let zone = '本机时区';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone; } catch { /* Offset remains available. */ }
  return `${zone}（UTC${sign}${hours}:${minutes}）`;
}

function decimal(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : MISSING;
}

function durationHours(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
  return value < 1 ? formatDuration(value * 3600000) : `${decimal(value)} 小时`;
}

function duration(entry, now) {
  if (entry.onsetPrecision === 'day') return '起止时间未记录，无法计算';
  const start = validDate(entry.start);
  const end = validDate(entry.end);
  if (start && end && end >= start) return durationHours((end - start) / 3600000);
  if (entry.endUnknown) return '已结束，结束时间不详';
  const current = validDate(now);
  if (start && current && current >= start) return `仍在持续，已 ${durationHours((current - start) / 3600000)}`;
  return '仍在持续，时长待确认';
}

function endText(entry) {
  if (entry.statusUnknown) return '是否已结束未记录';
  if (entry.onsetPrecision === 'day') return '已结束，起止时间未记录';
  return entry.end ? timestamp(entry.end) : entry.endUnknown ? '已结束，结束时间不详' : '仍在持续';
}

function inRange(value, from, to) {
  const key = dayKey(value);
  return Boolean(key && key >= from && key <= to);
}

function reportData(state, from, to, now) {
  const summary = summarize(state, from, to, now);
  const entries = summary.entries ?? [];
  const allEntries = state.entries ?? [];
  const selected = new Set(entries.map(entry => entry.id));
  const entryNumbers = new Map(entries.map((entry, index) => [entry.id, String(index + 1)]));
  const doses = [];
  for (const entry of allEntries) {
    for (const medication of entry.medications ?? []) {
      const within = inRange(medication.at, from, to);
      if (selected.has(entry.id) || within) {
        doses.push({ entry, medication, within, episodeNumber: entryNumbers.get(entry.id) ?? '范围外发作' });
      }
    }
  }
  doses.sort((a, b) => Date.parse(a.medication.at) - Date.parse(b.medication.at));
  const durationSample = entries.filter(entry => {
    if (entry.onsetPrecision === 'day' || entry.statusUnknown) return false;
    const start = validDate(entry.start);
    const end = validDate(entry.end);
    return start && end && end >= start;
  }).length;
  return { summary, entries, doses, durationSample };
}

function table(headers, rows, empty = '本时段没有相应记录') {
  const body = rows.length
    ? rows.map(row => `<tr>${row.map(cell => `<td>${escapeHTML(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="empty">${escapeHTML(empty)}</td></tr>`;
  return `<table><thead><tr>${headers.map(header => `<th scope="col">${escapeHTML(header)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function stat(value, caption, detail = '') {
  return `<div class="stat"><strong>${escapeHTML(value)}</strong><span>${escapeHTML(caption)}</span>${detail ? `<small>${escapeHTML(detail)}</small>` : ''}</div>`;
}

/** Build a standalone, script-free report suitable for browser printing to PDF. */
export function reportHTML(state, from, to, now = new Date()) {
  const { summary: s, entries, doses, durationSample } = reportData(state, from, to, now);
  const unknownStatusCount = s.unknownStatusCount ?? entries.filter(entry => entry.statusUnknown).length;
  const endedWithoutTimesCount = entries.filter(entry => entry.endUnknown && !entry.statusUnknown).length;
  const confirmed = s.headacheDays + s.noHeadacheDays;
  const patient = String(state.profile?.name ?? '').trim();
  const episodeRows = entries.map((entry, index) => [
    index + 1,
    startText(entry, true),
    endText(entry),
    duration(entry, now),
    entry.pain === null || entry.pain === undefined ? MISSING : `${entry.pain} / 10`,
    codedText(entry.impact),
  ]);
  const detailRows = entries.map((entry, index) => [
    index + 1, list(entry.locations), list(entry.character), list(entry.symptoms),
    list(entry.triggers), codedText(entry.menstruation),
  ]);
  const detailHeaders = ['序号', '部位', '感觉', '伴随症状', '怀疑诱因', '当时是否处在经期'];
  const detailsTable = entries.length
    ? `<div class="detail-table"><table><thead><tr>${detailHeaders.map(header => `<th scope="col">${escapeHTML(header)}</th>`).join('')}</tr></thead><tbody>${detailRows.map((row, index) => `<tr>${row.map(cell => `<td>${escapeHTML(cell)}</td>`).join('')}</tr><tr class="note-title"><th colspan="6" scope="row">记录 ${index + 1} 的备注</th></tr><tr class="note-row"><td colspan="6">${escapeHTML(text(entries[index].notes))}</td></tr>`).join('')}</tbody></table></div>`
    : table(detailHeaders, []);
  const medicationRows = doses.map(({ entry, medication, within, episodeNumber }) => [
    episodeNumber === '范围外发作' ? `范围外发作（${startText(entry)}）` : episodeNumber,
    timestamp(medication.at), text(medication.name), text(medication.dose),
    codedText(medication.relief), within ? '在所选时段内' : '时段外 · 仅供发作上下文',
  ]);
  const medicationSummaryRows = (s.medications ?? []).map(medication => [
    text(medication.name), medication.days, medication.doses,
    `${medication.goodRelief} / ${medication.reliefKnown}`,
  ]);
  const symptomRows = (s.symptoms ?? []).map(item => [text(item.name), item.count]);
  const triggerRows = (s.triggers ?? []).map(item => [text(item.name), item.count]);
  const monthlyRows = (s.monthly ?? []).map(month => [
    month.month, month.headacheDays, month.medicationDays, month.confirmedDays,
    month.recordCount, month.unknownDays,
    `${month.fromDay} 至 ${month.toDay}（${month.partialMonth ? '部分月' : '整月'}，${month.totalDays} 日）`,
  ]);
  const dailyRows = (s.dayDetails ?? []).map(day => [
    day.date, codedText(day.status), day.pain === null || day.pain === undefined ? MISSING : `${day.pain} / 10`,
    day.medication ? '有用药记录' : '无用药记录',
    day.status === 'unknown' ? MISSING : day.recordCount,
    day.carryoverCount ? `${day.carryoverCount} 条延续` : '无延续记录',
  ]);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>头痛记录 · 就诊报告</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#edf1ef;color:#202d29;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.report{max-width:1060px;margin:28px auto;padding:44px;background:white}header{border-bottom:2px solid #245849;padding-bottom:18px}h1{margin:0 0 8px;font-size:27px;letter-spacing:.03em}h2{margin:28px 0 10px;font-size:18px;color:#245849}h3{font-size:15px;margin:18px 0 8px}p{margin:8px 0}.meta{color:#53665e}.notice{background:#f3f6f4;padding:12px 16px;border-left:3px solid #769486;font-size:13px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}.stat{border:1px solid #d9e3dd;padding:13px}.stat strong{display:block;font-size:28px;line-height:1.25;color:#245849}.stat span,.stat small{display:block}.stat small{color:#627269;font-size:11px}table{width:100%;border-collapse:collapse;table-layout:auto;margin:8px 0 14px;font-size:12px}th,td{border:1px solid #d6dfd9;text-align:left;vertical-align:top;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#edf3ef;font-weight:600}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.empty{color:#627269;text-align:center;padding:18px}.fine{color:#627269;font-size:12px}.split{display:grid;grid-template-columns:1fr 1fr;gap:20px}a{color:#245849}footer{margin-top:26px;border-top:1px solid #d6dfd9;padding-top:12px;font-size:12px;color:#627269}.page-break{break-before:page}section{break-inside:auto}h2,h3{break-after:avoid}
.detail-table table{table-layout:fixed}.note-title th{font-weight:500;background:#f4f7f4}.note-row{break-inside:auto;page-break-inside:auto}
@page{size:A4 portrait;margin:13mm 11mm}@media print{body{background:white;font-size:11px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}.report{margin:0;padding:0;max-width:none}h1{font-size:23px}h2{font-size:15px;margin-top:20px}.stats{gap:7px;margin:15px 0}.stat{padding:9px}.stat strong{font-size:23px}table{font-size:9px}th,td{padding:5px}.notice{font-size:10px}.fine,footer{font-size:9px}.split{gap:12px}.page-break{break-before:auto}footer{break-inside:avoid;page-break-inside:avoid}a{text-decoration:none}}
${chartStyles()}
</style></head><body><main class="report">
<header><h1>头痛记录 · 就诊报告</h1>${patient ? `<p>姓名：${escapeHTML(patient)}</p>` : ''}<p class="meta">记录时段：${escapeHTML(from)} 至 ${escapeHTML(to)}（含首尾日期）<br>生成时间：${escapeHTML(timestamp(now))} · ${escapeHTML(zoneLabel(now))}</p></header>
<p class="notice">这是患者自述记录，仅用于与医生讨论，不作诊断或用药建议。未记录的日期不能视为无头痛；“已确认无头痛”来自本人主动确认。所有日期均按本机时区归属。</p>
<section><h2>时段概览</h2><div class="stats">
${stat(s.headacheDays, '有头痛的日期', `所选时段共 ${s.totalDays} 日`)}
${stat(s.noHeadacheDays, '已确认无头痛的日期')}
${stat(s.unknownDays, '未记录的日期', `记录覆盖 ${confirmed} / ${s.totalDays} 日`)}
${stat(s.medicationDays, '有用药记录的日期', '按服药日期统计，每日只计 1 次')}
</div>
${reportCharts(s)}
${table(['指标', '结果', '计算口径'], [
    ['头痛记录次数', `${s.recordCount} 次`, '每条记录计 1 次，按开始日期或仅日期记录的已知头痛日期归属；跨日延续不重复计次'],
    ['期间开始时间已知的发作', `${s.attackCount} 次`, '开始日期在所选时段内；不含仅日期记录'],
    ['仅知道日期的记录', `${s.dateOnlyCount ?? entries.filter(entry => entry.onsetPrecision === 'day').length} 条`, '本人确认这天有头痛，具体起止时间未记录'],
    ['与时段相交的记录', `${s.overlapCount} 条`, '包含发作记录及仅日期记录，也包含时段开始前发生的发作'],
    ['仍在持续', `${s.ongoingCount} 次`, '截至报告生成时间尚未记录结束'],
    ['已结束，起止或结束时间未记录', `${endedWithoutTimesCount} 条`, '仅包含已确认结束的记录；不纳入持续时长计算'],
    ['是否已结束未记录', `${unknownStatusCount} 条`, '仅确认当天有头痛；不计为仍在持续或已结束，也不纳入持续时长计算'],
    ['最高疼痛评分平均值', `${decimal(s.meanPain)} / 10；n = ${s.knownPainCount}`, '仅已填写评分的相交记录；每条记录填写一次最高评分'],
    ['持续时长中位数', `${durationHours(s.medianDurationHours)}；n = ${durationSample}`, '仅有明确结束时间的相交发作；使用完整时长，不按时段截断'],
    ['疼痛评分 ≥7 的日期', `${s.severeDays} 日`, '由已填写评分的记录推算'],
  ])}
<p class="fine">疼痛评分为本人记录的 0–10 分。跨午夜的发作可覆盖多个头痛日。结束时间不详但开始时间已知的发作仅确认开始日有头痛；仅日期记录只确认所填日期有头痛，不能推定起始日期。标为“是否已结束未记录”的记录不能推定为已结束或仍在持续。其他日期不会自动补齐。持续中的发作统计至报告生成时，可能需要补充确认。</p></section>
<section><h2>每月记录概况</h2>${table(['月份', '头痛日', '用药日', '已确认记录的日期', '头痛记录次数', '未记录日', '统计覆盖'], monthlyRows)}<p class="fine">月统计仅包含所选时段内日期；首尾月份未覆盖整月时明确标为“部分月”，不可当作完整月份比较。“已确认记录” = 有头痛日期 + 主动确认无头痛日期。“头痛记录次数”含仅日期记录，每条只计一次；由更早月份开始的延续可增加本月头痛日，但不重复计为本月新增记录。0 次只表示没有新增记录，未记录日不能视为无头痛日。</p></section>
<section><h2>用药汇总</h2>${table(['药物名称', '用药日期数', '记录剂量次数', '明显缓解 / 已填写效果次数'], medicationSummaryRows)}<p class="fine">汇总仅计算服药时间在所选时段内的记录。不同药物的用药日可能重叠，不能相加得到总用药日；药物名称按本人填写汇总。剂量次数表示记录条数，不代表片数或总剂量。未填写效果的记录不进入效果比例。</p></section>
<div class="split"><section><h2>伴随症状</h2>${table(['本人记录的症状', '记录次数'], symptomRows)}<p class="fine">${escapeHTML(s.symptomKnownCount ?? entries.filter(entry => Array.isArray(entry.symptoms)).length)} / ${escapeHTML(s.overlapCount)} 条记录已填写症状（含明确无）；未填写不视为无症状。</p></section><section><h2>本人怀疑的诱因</h2>${table(['可能相关因素', '记录次数'], triggerRows)}<p class="fine">${escapeHTML(s.triggerKnownCount ?? entries.filter(entry => Array.isArray(entry.triggers)).length)} / ${escapeHTML(s.overlapCount)} 条记录已填写诱因（含明确无）。仅表示本人怀疑有关，不证明因果关系。</p></section></div>
<section class="page-break"><h2>完整发作明细</h2><p class="fine">列出与所选时段相交的记录，保留已填写的起止时间及持续时长。序号只在本报告中使用；“（约）”表示开始时间为回忆估计。仅日期记录只确认那天曾有头痛，不能推定真正开始日期或时间，且不计入已知开始时间的发作次数及持续时长。空缺统一显示“未记录”，“已确认无”表示本人明确选择无。</p>${table(['序号', '开始时间 / 已知头痛日期', '结束时间 / 状态', '完整持续时长', '疼痛', '活动影响'], episodeRows)}
<h3>每次发作的补充记录</h3>${detailsTable}</section>
<section><h2>完整用药明细</h2><p class="fine">包含上述记录的全部用药明细，以及其他记录中服药时间在所选时段内的明细。标为“时段外”的剂量仅供上下文，未计入本报告的用药汇总。</p>${table(['对应记录序号', '服药时间', '药物名称', '本人填写的剂量', '本人感受的效果', '统计范围'], medicationRows)}</section>
<section><h2>逐日记录状态</h2>${table(['日期', '头痛状态', '当天已记录的最高疼痛', '用药记录', '当天头痛记录次数', '由更早日期延续'], dailyRows)}<p class="fine">当天记录次数按实际开始日期或仅日期记录的已知头痛日期归属，每条记录计 1 次。跨日延续单独列出，不重复计为当天的新一次；同一天多条记录仍只算 1 个头痛日。未记录的日期不显示为 0 次头痛。“无延续记录”和“无用药记录”均只表示没有相应记录，不表示本人确认没有。“当天已记录的最高疼痛”来自当天涉及记录已填写的评分，未填写评分不按 0 分处理。</p></section>
<footer><p>记录字段参考 <a href="https://www.nice.org.uk/guidance/cg150/chapter/Recommendations">NICE CG150，第 1.1.3–1.1.4 条（头痛日记）</a>：记录频率、持续时间、程度、伴随症状、用药、可能诱因及经期关系；指南建议至少记录 8 周。具体解释与评估请由医生结合病史完成。</p><p>本报告由本地头痛记录软件生成。请妥善保管报告及备份，其中可能包含个人健康信息。</p></footer>
</main></body></html>`;
}

// CSV cell quoting also protects spreadsheet readers from interpreting user text as formulas.
function csvCell(value) {
  let cell = String(value ?? '');
  if (/^[\s\uFEFF\u200B]*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM CSV: one row per episode or dose, with explicit time-range context. */
export function recordsCSV(state, from, to, now = new Date()) {
  const { entries, doses } = reportData(state, from, to, now);
  const headers = ['行类型', '对应发作ID', '统计范围', '开始时间或已知头痛日期', '时间精度', '结束时间或状态', '完整持续时长', '疼痛0-10', '部位', '感觉', '伴随症状', '怀疑诱因', '活动影响', '经期状态', '备注', '服药时间', '药物名称', '剂量', '本人感受的效果', '报告起始日期', '报告结束日期', '生成时间', '本机时区'];
  const meta = [from, to, timestamp(now), zoneLabel(now)];
  const rows = entries.map(entry => [
    '发作', entry.id, '与所选时段相交', csvStart(entry),
    precisionText(entry), endText(entry), duration(entry, now),
    entry.pain ?? MISSING, list(entry.locations), list(entry.character), list(entry.symptoms),
    list(entry.triggers), codedText(entry.impact), codedText(entry.menstruation), text(entry.notes),
    '', '', '', '', ...meta,
  ]);
  for (const { entry, medication, within } of doses) {
    rows.push([
      '用药', entry.id, within ? '在所选时段内' : '时段外 · 仅供发作上下文',
      csvStart(entry), precisionText(entry),
      endText(entry), '', '', '', '', '', '', '', '', '',
      timestamp(medication.at), text(medication.name), text(medication.dose), codedText(medication.relief), ...meta,
    ]);
  }
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Preserve the full state for lossless backup; importing must validate it separately. */
export function backupJSON(state) {
  return JSON.stringify(state);
}

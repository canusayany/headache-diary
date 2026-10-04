// Calendar-day calculations deliberately use local dates. An attack ending at
// midnight belongs to the preceding day; unrecorded days remain unknown.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_DAYS = 36_600;
const MAX_ENTRIES = 10_000;
const MAX_DOSES = 100_000;
const FUTURE_TOLERANCE = 5 * MINUTE;

export function emptyState() {
  return {
    schemaVersion: 1,
    revision: 0,
    profile: { name: '', theme: 'dark', medications: [] },
    entries: [],
    days: [],
  };
}

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
    fail(`${label}格式无效。`);
  }
  return value;
}

function text(value, label, max, fallback = '', required = false) {
  if (value == null && !required) return fallback;
  if (typeof value !== 'string') fail(`${label}必须是文字。`);
  const result = value.trim();
  if (result.length > max) fail(`${label}过长（最多 ${max} 个字符）。`);
  if (required && !result) fail(`${label}不能为空。`);
  return result;
}

function recordId(value, label) {
  const id = text(value, label, 100, '', true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${label}只能包含字母、数字、下划线和连字符。`);
  return id;
}

function list(value, label, max, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式或数量无效。`);
  return value;
}

function enumValue(value, allowed, label, fallback = null) {
  if (value == null) return fallback;
  if (!allowed.includes(value)) fail(`${label}取值无效。`);
  return value;
}

function bool(value, label, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') fail(`${label}必须是是或否。`);
  return value;
}

function calendarDay(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label}必须是有效日期（年-月-日）。`);
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) fail(`${label}无效。`);
  const daysInMonth = new Date(`${value.slice(0, 7)}-01T00:00:00.000Z`);
  daysInMonth.setUTCMonth(daysInMonth.getUTCMonth() + 1);
  daysInMonth.setUTCDate(0);
  if (day > daysInMonth.getUTCDate()) fail(`${label}无效。`);
  return value;
}

function isoDate(value, label, nowMs = Infinity) {
  if (typeof value !== 'string') fail(`${label}必须是有效时间。`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail(`${label}必须是带时区的有效时间。`);
  calendarDay(match[1], label);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) {
    fail(`${label}无效。`);
  }
  const zone = match[6];
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) fail(`${label}时区无效。`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label}无效。`);
  const parsed = new Date(milliseconds);
  if (parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) fail(`${label}年份超出支持范围。`);
  if (milliseconds > nowMs + FUTURE_TOLERANCE) fail(`${label}不能晚于现在。`);
  return parsed.toISOString();
}

function selections(value, label) {
  if (value == null) return null;
  const values = list(value, label, 100).map((item) => text(item, label, 80, '', true));
  if (new Set(values).size !== values.length) fail(`${label}含重复项。`);
  return values;
}

function nowTime(now) {
  const milliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(milliseconds)) fail('当前时间无效。');
  return milliseconds;
}

export function validateState(value, now = new Date()) {
  const state = object(value, '备份');
  if (state.schemaVersion !== 1) fail('备份版本不支持，请选择本软件导出的备份。');
  if (!Array.isArray(state.entries) || !Array.isArray(state.days)) {
    fail('备份缺少完整的头痛记录或无头痛日数据。');
  }
  const nowMs = nowTime(now);
  const today = dayKey(new Date(nowMs));
  const revision = state.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) fail('备份修订号无效。');
  const profile = object(state.profile ?? {}, '个人设置');
  const normalized = emptyState();
  normalized.revision = revision;
  normalized.profile = {
    name: text(profile.name, '姓名', 100),
    theme: enumValue(profile.theme, ['light', 'dark', 'system'], '显示模式', 'dark'),
    medications: list(profile.medications, '常用药', 50).map((item) => {
      object(item, '常用药');
      return { name: text(item.name, '药物名称', 120, '', true), dose: text(item.dose, '药物剂量', 120) };
    }),
  };
  const favoriteKeys = normalized.profile.medications.map((med) => `${med.name}\u0000${med.dose}`);
  if (new Set(favoriteKeys).size !== favoriteKeys.length) fail('常用药含重复项。');

  const entryIds = new Set();
  const doseIds = new Set();
  let activeCount = 0;
  let totalDoses = 0;
  normalized.entries = list(state.entries, '头痛记录', MAX_ENTRIES).map((raw) => {
    object(raw, '头痛记录');
    const id = recordId(raw.id, '记录编号');
    if (entryIds.has(id)) fail('头痛记录编号重复。');
    entryIds.add(id);
    const start = isoDate(raw.start, '开始时间', nowMs);
    const end = raw.end == null ? null : isoDate(raw.end, '结束时间', nowMs);
    const endUnknown = bool(raw.endUnknown, '结束时间未知');
    const onsetPrecision = enumValue(raw.onsetPrecision, ['exact', 'approximate', 'day'], '开始时间精度', 'exact');
    if (raw.statusUnknown !== undefined && typeof raw.statusUnknown !== 'boolean') {
      fail('结束状态未知必须是是或否。');
    }
    const statusUnknown = raw.statusUnknown === true;
    if (statusUnknown && (onsetPrecision !== 'day' || end !== null || !endUnknown)) {
      fail('结束状态未知只适用于仅记日期且起止时间不详的记录。');
    }
    if (onsetPrecision === 'day' && (end !== null || !endUnknown)) {
      fail('仅记日期的发作须标为结束时间不详，不能填写结束时间或标为持续中。');
    }
    if (dayKey(start) > today) {
      fail(onsetPrecision === 'day' ? '仅记日期的记录不能填写未来日期。' : '头痛开始日期不能填写未来日期。');
    }
    if (endUnknown && end !== null) fail('结束时间和结束时间未知不能同时填写。');
    if (end !== null && Date.parse(end) < Date.parse(start)) fail('结束时间不能早于开始时间。');
    if (end === null && !endUnknown) activeCount++;
    const pain = raw.pain ?? null;
    if (pain !== null && (!Number.isInteger(pain) || pain < 0 || pain > 10)) fail('疼痛评分必须为 0 到 10 的整数，或留空。');
    const medications = list(raw.medications, '用药记录', 1_000).map((dose) => {
      object(dose, '用药记录');
      const doseId = recordId(dose.id, '用药编号');
      if (doseIds.has(doseId)) fail('用药编号重复。');
      doseIds.add(doseId);
      if (++totalDoses > MAX_DOSES) fail('用药记录数量过多。');
      return {
        id: doseId,
        name: text(dose.name, '药物名称', 120, '', true),
        dose: text(dose.dose, '药物剂量', 120),
        at: isoDate(dose.at, '服药时间', nowMs),
        relief: enumValue(dose.relief, ['none', 'partial', 'good'], '用药效果'),
      };
    });
    return {
      id,
      start,
      end,
      endUnknown,
      onsetPrecision,
      ...(statusUnknown ? { statusUnknown: true } : {}),
      pain,
      symptoms: selections(raw.symptoms, '伴随症状'),
      locations: selections(raw.locations, '头痛位置'),
      character: selections(raw.character, '头痛感觉'),
      triggers: selections(raw.triggers, '可能诱因'),
      impact: enumValue(raw.impact, ['normal', 'reduced', 'bedrest'], '活动影响'),
      menstruation: enumValue(raw.menstruation, ['yes', 'no', 'unsure'], '月经情况'),
      notes: text(raw.notes, '备注', 4_000),
      medications,
      createdAt: isoDate(raw.createdAt ?? start, '创建时间', nowMs),
      updatedAt: isoDate(raw.updatedAt ?? raw.createdAt ?? start, '更新时间', nowMs),
    };
  });
  if (activeCount > 1) fail('备份中有多条仍在持续的头痛，请先核对结束状态。');

  const dayDates = new Set();
  normalized.days = list(state.days, '无头痛日', MAX_DAYS).map((raw) => {
    object(raw, '无头痛日');
    const date = calendarDay(raw.date, '无头痛日');
    if (date > today) fail('无头痛日不能填写未来日期。');
    if (raw.status !== 'no-headache') fail('无头痛日状态无效。');
    if (dayDates.has(date)) fail('无头痛日日期重复。');
    dayDates.add(date);
    return { date, status: 'no-headache' };
  });
  return normalized;
}

export function dayKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDay(value);
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('日期无效。');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateRangeDays(startDay, endDay) {
  calendarDay(startDay, '起始日期');
  calendarDay(endDay, '结束日期');
  if (endDay < startDay) fail('结束日期不能早于起始日期。');
  const startMs = Date.parse(`${startDay}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDay}T00:00:00.000Z`);
  const count = Math.round((endMs - startMs) / DAY) + 1;
  if (count > MAX_DAYS) fail('日期范围过长，请选择不超过 100 年的范围。');
  return Array.from({ length: count }, (_, index) => new Date(startMs + index * DAY).toISOString().slice(0, 10));
}

export function coveredDays(entry, fromDay, toDay, now = new Date()) {
  calendarDay(fromDay, '起始日期');
  calendarDay(toDay, '结束日期');
  if (toDay < fromDay) fail('结束日期不能早于起始日期。');
  const startMs = Date.parse(entry.start);
  if (!Number.isFinite(startMs)) fail('头痛开始时间无效。');
  let firstMs = startMs;
  let lastMs = startMs;
  if (entry.end !== null && entry.end !== undefined) {
    const endMs = Date.parse(entry.end);
    if (!Number.isFinite(endMs) || endMs < startMs) fail('头痛结束时间无效。');
    // A zero-length record still establishes headache on its onset date.
    lastMs = endMs > startMs ? endMs - 1 : startMs;
  } else if (!entry.endUnknown) {
    const currentMs = nowTime(now);
    if (startMs > currentMs) {
      // A small clock difference must not turn an ongoing headache into an
      // unrecorded day. Never move an actual future calendar date backwards.
      if (startMs - currentMs > FUTURE_TOLERANCE || dayKey(new Date(startMs)) !== dayKey(new Date(currentMs))) return [];
      firstMs = currentMs;
    }
    lastMs = currentMs;
  }
  const firstDay = dayKey(new Date(firstMs));
  const lastDay = dayKey(new Date(lastMs));
  const clippedFrom = firstDay > fromDay ? firstDay : fromDay;
  const clippedTo = lastDay < toDay ? lastDay : toDay;
  return clippedTo < clippedFrom ? [] : dateRangeDays(clippedFrom, clippedTo);
}

export function activeEntry(state) {
  return state.entries.find((entry) => entry.end == null && !entry.endUnknown) ?? null;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未记录';
  if (milliseconds < MINUTE) return '不足 1 分钟';
  const minutes = Math.floor(milliseconds / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function countSelections(entries, field) {
  const counts = new Map();
  for (const entry of entries) {
    for (const name of new Set(entry[field] ?? [])) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function summarize(state, fromDay, toDay, now = new Date()) {
  const rangeDays = dateRangeDays(fromDay, toDay);
  const headache = new Map();
  // Count recorded onsets once on their local date. Calendar-day coverage is
  // separate: a long headache can affect later days without adding onsets.
  const recordCounts = new Map();
  const attackCounts = new Map();
  const dateOnlyCounts = new Map();
  const carryoverCounts = new Map();
  const medicationDates = new Set();
  const medicationStats = new Map();
  const noHeadache = new Set(state.days.filter((day) => day.status === 'no-headache').map((day) => day.date));
  const overlaps = [];
  for (const entry of state.entries) {
    const onsetDay = dayKey(entry.start);
    if (onsetDay >= fromDay && onsetDay <= toDay) {
      recordCounts.set(onsetDay, (recordCounts.get(onsetDay) ?? 0) + 1);
      if (entry.onsetPrecision === 'day') {
        dateOnlyCounts.set(onsetDay, (dateOnlyCounts.get(onsetDay) ?? 0) + 1);
      } else if (entry.statusUnknown !== true) {
        attackCounts.set(onsetDay, (attackCounts.get(onsetDay) ?? 0) + 1);
      }
    }
    const dates = coveredDays(entry, fromDay, toDay, now);
    if (dates.length) {
      overlaps.push(entry);
      for (const date of dates) {
        const previous = headache.get(date);
        headache.set(date, previous == null ? (entry.pain ?? null) : Math.max(previous, entry.pain ?? previous));
        if (date > onsetDay && entry.onsetPrecision !== 'day' && entry.statusUnknown !== true) {
          carryoverCounts.set(date, (carryoverCounts.get(date) ?? 0) + 1);
        }
      }
    }
    for (const dose of entry.medications ?? []) {
      const date = dayKey(dose.at);
      if (date < fromDay || date > toDay) continue;
      medicationDates.add(date);
      const stats = medicationStats.get(dose.name) ?? { name: dose.name, dates: new Set(), doses: 0, reliefKnown: 0, goodRelief: 0 };
      stats.dates.add(date);
      stats.doses++;
      if (dose.relief != null) stats.reliefKnown++;
      if (dose.relief === 'good') stats.goodRelief++;
      medicationStats.set(dose.name, stats);
    }
  }
  overlaps.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const dayDetails = rangeDays.map((date) => ({
    date,
    status: headache.has(date) ? 'headache' : noHeadache.has(date) ? 'no-headache' : 'unknown',
    pain: headache.get(date) ?? null,
    medication: medicationDates.has(date),
    recordCount: recordCounts.get(date) ?? 0,
    carryoverCount: carryoverCounts.get(date) ?? 0,
  }));
  const monthlyMap = new Map();
  for (const day of dayDetails) {
    const month = day.date.slice(0, 7);
    const row = monthlyMap.get(month) ?? {
      month, headacheDays: 0, medicationDays: 0, confirmedDays: 0,
      recordCount: 0, attackCount: 0, dateOnlyCount: 0,
      totalDays: 0, unknownDays: 0, noHeadacheDays: 0,
      fromDay: day.date, toDay: day.date, partialMonth: false,
    };
    row.totalDays++;
    row.toDay = day.date;
    row.recordCount += day.recordCount;
    row.attackCount += attackCounts.get(day.date) ?? 0;
    row.dateOnlyCount += dateOnlyCounts.get(day.date) ?? 0;
    if (day.status === 'headache') row.headacheDays++;
    if (day.status === 'no-headache') row.noHeadacheDays++;
    if (day.status === 'unknown') row.unknownDays++;
    if (day.status !== 'unknown') row.confirmedDays++;
    if (day.medication) row.medicationDays++;
    monthlyMap.set(month, row);
  }
  for (const row of monthlyMap.values()) {
    const lastDay = new Date(`${row.month}-01T00:00:00.000Z`);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
    lastDay.setUTCDate(0);
    row.partialMonth = row.fromDay !== `${row.month}-01` || row.toDay !== lastDay.toISOString().slice(0, 10);
  }
  const durations = overlaps.filter((entry) => entry.end != null && entry.onsetPrecision !== 'day').map((entry) => (Date.parse(entry.end) - Date.parse(entry.start)) / HOUR);
  const knownPain = overlaps.filter((entry) => entry.pain != null).map((entry) => entry.pain);
  const headacheDays = dayDetails.filter((day) => day.status === 'headache').length;
  const noHeadacheDays = dayDetails.filter((day) => day.status === 'no-headache').length;
  return {
    fromDay,
    toDay,
    totalDays: rangeDays.length,
    headacheDays,
    noHeadacheDays,
    confirmedDays: headacheDays + noHeadacheDays,
    unknownDays: rangeDays.length - headacheDays - noHeadacheDays,
    recordCount: [...recordCounts.values()].reduce((total, count) => total + count, 0),
    attackCount: [...attackCounts.values()].reduce((total, count) => total + count, 0),
    dateOnlyCount: overlaps.filter((entry) => entry.onsetPrecision === 'day').length,
    overlapCount: overlaps.length,
    ongoingCount: overlaps.filter((entry) => entry.end == null && !entry.endUnknown).length,
    unknownStatusCount: overlaps.filter((entry) => entry.statusUnknown === true).length,
    unknownDurationCount: overlaps.filter((entry) => entry.endUnknown).length,
    completedCount: overlaps.filter((entry) => entry.statusUnknown !== true && (entry.end != null || entry.endUnknown)).length,
    knownDurationCount: durations.length,
    medianDurationHours: median(durations),
    meanPain: knownPain.length ? knownPain.reduce((sum, value) => sum + value, 0) / knownPain.length : null,
    knownPainCount: knownPain.length,
    symptomKnownCount: overlaps.filter((entry) => entry.symptoms != null).length,
    triggerKnownCount: overlaps.filter((entry) => entry.triggers != null).length,
    medicationDays: medicationDates.size,
    severeDays: dayDetails.filter((day) => day.status === 'headache' && day.pain != null && day.pain >= 7).length,
    dayDetails,
    monthly: [...monthlyMap.values()],
    medications: [...medicationStats.values()].map(({ dates, ...row }) => ({ ...row, days: dates.size })).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name, 'zh-CN')),
    symptoms: countSelections(overlaps, 'symptoms'),
    triggers: countSelections(overlaps, 'triggers'),
    entries: overlaps,
  };
}

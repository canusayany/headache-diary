import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { emptyState, validateState, dayKey, dateRangeDays, coveredDays, activeEntry, formatDuration, summarize } from '../model.js';

const NOW = new Date('2026-10-04T12:00:00+08:00');
const instant = (day, time = '12:00:00') => new Date(`${day}T${time}+08:00`).toISOString();
const episode = (id, start, end = null, fields = {}) => ({
  id, start, end, endUnknown: false, onsetPrecision: 'exact', pain: null,
  symptoms: null, locations: null, character: null, triggers: null,
  impact: null, menstruation: null, notes: '', medications: [],
  createdAt: start, updatedAt: end ?? start, ...fields,
});
const stateWith = (...entries) => ({ ...emptyState(), entries });

test('calendar dates use local calendar and reject invalid leap dates', () => {
  const local = new Date(2026, 9, 4, 0, 30);
  assert.equal(dayKey(local), '2026-10-04');
  assert.deepEqual(dateRangeDays('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.throws(() => dateRangeDays('2026-02-29', '2026-03-01'), /无效/);
  assert.throws(() => dateRangeDays('2026-02-30', '2026-03-01'), /无效/);
  assert.throws(() => dateRangeDays('2026-10-04', '2026-10-03'), /早于/);
});

test('cross-midnight attack covers both days while exact midnight ending excludes the next day', () => {
  // Construct local instants so the test is independent of machine timezone.
  const begin = new Date(2026, 9, 1, 23, 30).toISOString();
  const after = new Date(2026, 9, 2, 0, 30).toISOString();
  const midnight = new Date(2026, 9, 2, 0, 0).toISOString();
  assert.deepEqual(coveredDays(episode('a', begin, after), '2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(coveredDays(episode('a', begin, midnight), '2026-10-01', '2026-10-03'), ['2026-10-01']);
  assert.deepEqual(coveredDays(episode('a', begin, after), '2026-10-02', '2026-10-02'), ['2026-10-02']);
  assert.deepEqual(coveredDays(episode('a', begin, midnight), '2026-10-02', '2026-10-02'), []);
});

test('midnight coverage distinguishes a known exclusive ending from an ongoing inclusive instant', () => {
  const midnight = new Date(2026, 9, 2, 0, 0, 0).getTime();
  const justBefore = new Date(midnight - 1).toISOString();
  const exactly = new Date(midnight).toISOString();
  const justAfter = new Date(midnight + 1).toISOString();
  assert.deepEqual(coveredDays(episode('one-ms-before', justBefore, exactly), '2026-10-01', '2026-10-02'), ['2026-10-01']);
  assert.deepEqual(coveredDays(episode('one-ms-after', justBefore, justAfter), '2026-10-01', '2026-10-02'), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(coveredDays(episode('ongoing-at-midnight', justBefore), '2026-10-01', '2026-10-02', new Date(midnight)), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(coveredDays(episode('zero-at-midnight', exactly, exactly), '2026-10-01', '2026-10-02'), ['2026-10-02']);
});

test('unknown ending covers onset only; ongoing attacks cover dates only through now', () => {
  const start = new Date(2026, 9, 1, 23, 0).toISOString();
  const now = new Date(2026, 9, 3, 0, 5);
  const unknown = episode('unknown', start, null, { endUnknown: true });
  assert.deepEqual(coveredDays(unknown, '2026-10-01', '2026-10-04', now), ['2026-10-01']);
  const ongoing = episode('ongoing', start);
  assert.deepEqual(coveredDays(ongoing, '2026-10-01', '2026-10-04', now), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(activeEntry(stateWith(unknown)), null);
  assert.equal(activeEntry(stateWith(unknown, ongoing)), ongoing);
});

test('summary distinguishes unknown days, headache priority, and missing scores from zero', () => {
  const start = new Date(2026, 9, 1, 10).toISOString();
  const end = new Date(2026, 9, 1, 12).toISOString();
  const state = stateWith(episode('a', start, end));
  state.days = [{ date: '2026-10-01', status: 'no-headache' }, { date: '2026-10-02', status: 'no-headache' }];
  const result = summarize(state, '2026-10-01', '2026-10-03', NOW);
  assert.equal(result.headacheDays, 1);
  assert.equal(result.noHeadacheDays, 1);
  assert.equal(result.unknownDays, 1);
  assert.equal(result.confirmedDays, 2);
  assert.equal(result.meanPain, null);
  assert.equal(result.knownPainCount, 0);
  assert.equal(result.dayDetails[0].pain, null);
  assert.equal(result.dayDetails[0].status, 'headache');
  assert.equal(result.dayDetails[2].status, 'unknown');
  state.entries[0].pain = 0;
  assert.equal(summarize(state, '2026-10-01', '2026-10-03', NOW).meanPain, 0);
});

test('summary clips calendar days but preserves full duration and distinguishes onset count', () => {
  const start = new Date(2026, 8, 30, 23).toISOString();
  const end = new Date(2026, 9, 2, 1).toISOString();
  const result = summarize(stateWith(episode('a', start, end, { pain: 8 })), '2026-10-01', '2026-10-01', NOW);
  assert.equal(result.totalDays, 1);
  assert.equal(result.headacheDays, 1);
  assert.equal(result.attackCount, 0);
  assert.equal(result.overlapCount, 1);
  assert.equal(result.medianDurationHours, 26);
  assert.equal(result.severeDays, 1);
});

test('multiple doses on one day count once and doses are selected by their own time', () => {
  const start = new Date(2026, 8, 30, 10).toISOString();
  const end = new Date(2026, 8, 30, 12).toISOString();
  const at = new Date(2026, 9, 1, 9).toISOString();
  const state = stateWith(episode('old', start, end, { medications: [
    { id: 'm1', name: '记录药 A', dose: '', at, relief: 'good' },
    { id: 'm2', name: '记录药 A', dose: '', at, relief: null },
    { id: 'm3', name: '记录药 B', dose: '', at, relief: 'partial' },
    { id: 'm4', name: '记录药 A', dose: '', at: start, relief: 'none' },
  ] }));
  const result = summarize(state, '2026-10-01', '2026-10-02', NOW);
  assert.equal(result.overlapCount, 0);
  assert.equal(result.medicationDays, 1);
  assert.equal(result.headacheDays, 0);
  assert.equal(result.dayDetails[0].medication, true);
  assert.deepEqual(result.medications.find((row) => row.name === '记录药 A'), { name: '记录药 A', doses: 2, reliefKnown: 1, goodRelief: 1, days: 1 });
});

test('unknown durations and ongoing episodes are omitted from median duration samples', () => {
  const makeLocal = (day, hour) => new Date(2026, 9, day, hour).toISOString();
  const state = stateWith(
    episode('known1', makeLocal(1, 8), makeLocal(1, 10), { pain: 8, symptoms: ['恶心'], triggers: ['少睡'] }),
    episode('known2', makeLocal(2, 8), makeLocal(2, 12), { pain: 4, symptoms: [], triggers: null }),
    episode('unknown', makeLocal(3, 8), null, { endUnknown: true }),
    episode('ongoing', makeLocal(4, 8)),
  );
  const result = summarize(state, '2026-10-01', '2026-10-04', new Date(2026, 9, 4, 12));
  assert.equal(result.attackCount, 4);
  assert.equal(result.unknownDurationCount, 1);
  assert.equal(result.ongoingCount, 1);
  assert.equal(result.completedCount, 3);
  assert.equal(result.knownDurationCount, 2);
  assert.equal(result.medianDurationHours, 3);
  assert.equal(result.meanPain, 6);
  assert.equal(result.symptomKnownCount, 2);
  assert.equal(result.triggerKnownCount, 1);
  assert.deepEqual(result.symptoms, [{ name: '恶心', count: 1 }]);
  assert.deepEqual(result.monthly, [{
    month: '2026-10', headacheDays: 4, medicationDays: 0, confirmedDays: 4,
    recordCount: 4, attackCount: 4, dateOnlyCount: 0,
    totalDays: 4, unknownDays: 0, noHeadacheDays: 0,
    fromDay: '2026-10-01', toDay: '2026-10-04', partialMonth: true,
  }]);
});

test('safe defaults normalize without mutating input', () => {
  const input = { schemaVersion: 1, entries: [{ id: 'a', start: instant('2026-10-01'), end: instant('2026-10-01', '13:00:00'), pain: null }], days: [] };
  const copy = structuredClone(input);
  const result = validateState(input, NOW);
  assert.deepEqual(input, copy);
  assert.equal(result.entries[0].endUnknown, false);
  assert.equal(result.entries[0].symptoms, null);
  assert.equal(result.entries[0].notes, '');
  assert.deepEqual(result.entries[0].medications, []);
  assert.deepEqual(result.profile, emptyState().profile);
  assert.equal(emptyState().profile.theme, 'dark');
  assert.equal(result.profile.theme, 'dark');
});

test('default dark mode preserves an explicitly chosen display preference', () => {
  for (const theme of ['light', 'dark', 'system']) {
    const state = emptyState();
    state.profile.theme = theme;
    assert.equal(validateState(state, NOW).profile.theme, theme);
  }
  const withoutTheme = emptyState();
  delete withoutTheme.profile.theme;
  assert.equal(validateState(withoutTheme, NOW).profile.theme, 'dark');
});

test('malformed imports reject corrupt schema, impossible dates, future times, and backwards ending', () => {
  assert.throws(() => validateState({}, NOW), /版本/);
  assert.throws(() => validateState({ schemaVersion: 1 }, NOW), /缺少完整/);
  assert.throws(() => validateState({ ...emptyState(), schemaVersion: 2 }, NOW), /版本/);
  assert.throws(() => validateState({ ...emptyState(), entries: null }, NOW), /缺少完整/);
  assert.throws(() => validateState(stateWith(episode('bad', '2026-02-30T12:00:00Z')), NOW), /无效/);
  assert.throws(() => validateState(stateWith(episode('bad', '2026-10-01T25:00:00Z')), NOW), /无效/);
  assert.throws(() => validateState(stateWith(episode('bad', '2026-10-01T12:00:00')), NOW), /时区/);
  assert.throws(() => validateState(stateWith(episode('bad', instant('2026-10-04', '12:06:00'))), NOW), /现在/);
  assert.doesNotThrow(() => validateState(stateWith(episode('tolerated', instant('2026-10-04', '12:04:00'))), NOW));
  assert.throws(() => validateState(stateWith(episode('back', instant('2026-10-02'), instant('2026-10-01'))), NOW), /早于/);
  assert.throws(() => validateState({ ...emptyState(), days: [{ date: '2026-02-29', status: 'no-headache' }] }, NOW), /无效/);
});

test('malformed imports reject duplicate records, doses, days, and multiple ongoing attacks', () => {
  const start = instant('2026-10-01');
  const end = instant('2026-10-01', '13:00:00');
  const first = episode('a', start, end);
  assert.throws(() => validateState(stateWith(first, structuredClone(first)), NOW), /编号重复/);
  assert.throws(() => validateState(stateWith(episode('a', start), episode('b', start)), NOW), /多条仍在持续/);
  assert.throws(() => validateState(stateWith(episode('a', start, end, { endUnknown: true })), NOW), /不能同时/);
  const dose = { id: 'd', name: '药物', dose: '', at: start, relief: null };
  assert.throws(() => validateState(stateWith(episode('a', start, end, { medications: [dose, structuredClone(dose)] })), NOW), /用药编号重复/);
  const day = { date: '2026-10-01', status: 'no-headache' };
  assert.throws(() => validateState({ ...emptyState(), days: [day, day] }, NOW), /日期重复/);
  assert.throws(() => validateState(stateWith(episode('a', start, end, { pain: '' })), NOW), /疼痛评分/);
  assert.throws(() => validateState(stateWith(episode('a', start, end, { symptoms: ['恶心', '恶心'] })), NOW), /重复项/);
});

test('duration text does not round short ongoing intervals to zero hours', () => {
  assert.equal(formatDuration(20_000), '不足 1 分钟');
  assert.equal(formatDuration(90 * 60_000), '1 小时 30 分钟');
  assert.equal(formatDuration(3_600_000), '1 小时');
  assert.equal(formatDuration(NaN), '未记录');
});

test('medication names and doses use the same 120 character limit as the form', () => {
  const start = instant('2026-10-01');
  const end = instant('2026-10-01', '13:00:00');
  const name = '药'.repeat(120), dose = '量'.repeat(120);
  const state = stateWith(episode('valid-id_1', start, end, { medications: [{ id: 'dose-id_1', name, dose, at: start, relief: null }] }));
  state.profile.medications = [{ name, dose }];
  assert.doesNotThrow(() => validateState(state, NOW));
  const invalid = structuredClone(state);
  invalid.entries[0].medications[0].name += '药';
  assert.throws(() => validateState(invalid, NOW), /最多 120/);
  const invalidFavorite = structuredClone(state);
  invalidFavorite.profile.medications[0].dose += '量';
  assert.throws(() => validateState(invalidFavorite, NOW), /最多 120/);
});

test('untrusted imported record identifiers cannot inject HTML attributes', () => {
  const start = instant('2026-10-01');
  const end = instant('2026-10-01', '13:00:00');
  assert.throws(() => validateState(stateWith(episode('bad" autofocus="true', start, end)), NOW), /只能包含/);
  assert.throws(() => validateState(stateWith(episode('safe', start, end, { medications: [{ id: '<script>', name: '药物', dose: '', at: start, relief: null }] })), NOW), /只能包含/);
});

test('date-only retrospective entries count the known date without inventing start time or duration', () => {
  const placeholder = new Date(2026, 9, 1, 0, 0, 0).toISOString();
  const input = stateWith(episode('day-only', placeholder, null, { onsetPrecision: 'day', endUnknown: true, pain: 5 }));
  const state = validateState(input, NOW);
  assert.equal(state.entries[0].onsetPrecision, 'day');
  assert.equal(activeEntry(state), null);
  assert.deepEqual(coveredDays(state.entries[0], '2026-10-01', '2026-10-03', NOW), ['2026-10-01']);
  assert.deepEqual(coveredDays(state.entries[0], '2026-10-02', '2026-10-03', NOW), []);
  const result = summarize(state, '2026-10-01', '2026-10-03', NOW);
  assert.equal(result.attackCount, 0);
  assert.equal(result.dateOnlyCount, 1);
  assert.equal(result.headacheDays, 1);
  assert.equal(result.unknownDays, 2);
  assert.equal(result.ongoingCount, 0);
  assert.equal(result.completedCount, 1);
  assert.equal(result.unknownDurationCount, 1);
  assert.equal(result.knownDurationCount, 0);
  assert.equal(result.medianDurationHours, null);
});

test('date-only onset precision cannot be paired with a known ending or ongoing state', () => {
  const start = new Date(2026, 9, 1, 0, 0, 0).toISOString();
  const end = new Date(2026, 9, 1, 12, 0, 0).toISOString();
  assert.throws(() => validateState(stateWith(episode('known-end', start, end, { onsetPrecision: 'day' })), NOW), /仅记日期/);
  assert.throws(() => validateState(stateWith(episode('ongoing-day', start, null, { onsetPrecision: 'day' })), NOW), /仅记日期/);
  const normal = episode('default-precision', start, end);
  delete normal.onsetPrecision;
  assert.equal(validateState(stateWith(normal), NOW).entries[0].onsetPrecision, 'exact');
});

test('one-tap entries preserve an unknown ending status through validation, JSON export, and later detail changes', () => {
  const start = new Date(2026, 9, 1, 0).toISOString();
  const input = stateWith(episode('one-tap', start, null, {
    onsetPrecision: 'day', endUnknown: true, statusUnknown: true,
  }));
  const before = structuredClone(input);
  const normalized = validateState(input, NOW);
  assert.deepEqual(input, before);
  assert.equal(normalized.entries[0].statusUnknown, true);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(normalized)), NOW), normalized);
  normalized.revision++;
  normalized.entries[0].pain = 6;
  normalized.entries[0].symptoms = ['畏光'];
  normalized.entries[0].notes = '休息后再补充';
  normalized.entries[0].updatedAt = NOW.toISOString();
  const updated = validateState(normalized, NOW);
  assert.equal(updated.entries[0].statusUnknown, true);
  assert.equal(updated.entries[0].pain, 6);
  assert.deepEqual(updated.entries[0].symptoms, ['畏光']);
  assert.equal(updated.entries[0].end, null);
  assert.equal(updated.entries[0].onsetPrecision, 'day');
});

test('omitted and false unknown-status flags retain the legacy entry shape and completed semantics', () => {
  const start = new Date(2026, 9, 1, 0).toISOString();
  const legacy = episode('legacy-date', start, null, { onsetPrecision: 'day', endUnknown: true });
  const normalized = validateState(stateWith(legacy), NOW);
  assert.equal(Object.hasOwn(normalized.entries[0], 'statusUnknown'), false);
  assert.deepEqual(validateState(stateWith({ ...legacy, statusUnknown: false }), NOW), normalized);
  assert.equal(summarize(normalized, '2026-10-01', '2026-10-01', NOW).completedCount, 1);
  assert.equal(summarize(normalized, '2026-10-01', '2026-10-01', NOW).unknownStatusCount, 0);
  const exact = episode('legacy-exact', start, new Date(2026, 9, 1, 1).toISOString());
  assert.deepEqual(validateState(stateWith({ ...exact, statusUnknown: false }), NOW), validateState(stateWith(exact), NOW));
});

test('unknown ending status rejects nonboolean values rather than silently inventing a known status', () => {
  const start = new Date(2026, 9, 1, 0).toISOString();
  const base = episode('one-tap', start, null, { onsetPrecision: 'day', endUnknown: true });
  for (const statusUnknown of [null, 'true', 'false', 0, 1, [], {}]) {
    assert.throws(() => validateState(stateWith({ ...base, statusUnknown }), NOW), /结束状态未知必须是是或否/);
  }
});

test('unknown ending status cannot accompany precise onset, a known ending, or an ongoing entry', () => {
  const start = new Date(2026, 9, 1, 0).toISOString();
  const end = new Date(2026, 9, 1, 1).toISOString();
  const invalid = [
    episode('exact', start, null, { onsetPrecision: 'exact', endUnknown: true, statusUnknown: true }),
    episode('approximate', start, null, { onsetPrecision: 'approximate', endUnknown: true, statusUnknown: true }),
    episode('known-end', start, end, { onsetPrecision: 'day', endUnknown: true, statusUnknown: true }),
    episode('ongoing-day', start, null, { onsetPrecision: 'day', endUnknown: false, statusUnknown: true }),
    episode('ongoing-exact', start, null, { statusUnknown: true }),
  ];
  for (const entry of invalid) {
    assert.throws(() => validateState(stateWith(entry), NOW), /结束状态未知只适用于/);
  }
});

test('one-tap entries establish only their recorded day without inferring a completed or ongoing headache', () => {
  const start = new Date(2026, 9, 1, 0).toISOString();
  const state = validateState(stateWith(episode('one-tap', start, null, {
    onsetPrecision: 'day', endUnknown: true, statusUnknown: true,
  })), NOW);
  assert.equal(activeEntry(state), null);
  assert.deepEqual(coveredDays(state.entries[0], '2026-10-01', '2026-10-04', NOW), ['2026-10-01']);
  const summary = summarize(state, '2026-10-01', '2026-10-04', NOW);
  assert.equal(summary.headacheDays, 1);
  assert.equal(summary.unknownDays, 3);
  assert.equal(summary.dateOnlyCount, 1);
  assert.equal(summary.attackCount, 0);
  assert.equal(summary.overlapCount, 1);
  assert.equal(summary.unknownStatusCount, 1);
  assert.equal(summary.completedCount, 0);
  assert.equal(summary.ongoingCount, 0);
  assert.equal(summary.unknownDurationCount, 1);
  assert.equal(summary.knownDurationCount, 0);
  assert.equal(summary.medianDurationHours, null);
  assert.equal(summary.meanPain, null);
  assert.equal(summarize(state, '2026-10-02', '2026-10-04', NOW).unknownStatusCount, 0);
});

test('unknown status, legacy completed records, and a real ongoing entry remain distinct in mixed data', () => {
  const local = (day, hour = 0) => new Date(2026, 9, day, hour).toISOString();
  const state = validateState(stateWith(
    episode('unknown-one', local(1), null, { onsetPrecision: 'day', endUnknown: true, statusUnknown: true }),
    episode('unknown-two', local(1), null, { onsetPrecision: 'day', endUnknown: true, statusUnknown: true }),
    episode('legacy-day', local(2), null, { onsetPrecision: 'day', endUnknown: true }),
    episode('completed', local(3, 8), local(3, 10)),
    episode('ongoing', local(4, 8)),
  ), NOW);
  assert.equal(activeEntry(state).id, 'ongoing');
  const summary = summarize(state, '2026-10-01', '2026-10-04', NOW);
  assert.equal(summary.headacheDays, 4);
  assert.equal(summary.unknownStatusCount, 2);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.ongoingCount, 1);
  assert.equal(summary.unknownDurationCount, 3);
  assert.equal(summary.knownDurationCount, 1);
  assert.equal(summary.medianDurationHours, 2);
  assert.equal(summary.dateOnlyCount, 3);
  assert.equal(summary.attackCount, 2);
  assert.equal(summary.overlapCount, summary.completedCount + summary.ongoingCount + summary.unknownStatusCount);
});

test('different medication days, cross-month attacks, and conflicting no-headache marks aggregate correctly', () => {
  const local = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
  const start = local(9, 30, 23, 30);
  const state = stateWith(
    episode('cross-month', start, local(10, 2), { pain: 7, medications: [
      { id: 'dose-a1', name: '药 A', dose: '1 片', at: local(9, 30, 23, 45), relief: 'none' },
      { id: 'dose-a2', name: '药 A', dose: '1 片', at: local(10, 1, 9), relief: 'partial' },
      { id: 'dose-a3', name: '药 A', dose: '1 片', at: local(10, 1, 12), relief: 'good' },
      { id: 'dose-b1', name: '药 B', dose: '', at: local(10, 1, 14), relief: null },
      { id: 'dose-outside', name: '药 A', dose: '', at: local(10, 3, 8), relief: 'good' },
    ] }),
    episode('second-same-day', local(10, 1, 18), local(10, 1, 20), { pain: 9 }),
    episode('date-only-october', local(10, 2), null, { onsetPrecision: 'day', endUnknown: true, pain: 3 }),
  );
  state.days = [{ date: '2026-09-30', status: 'no-headache' }, { date: '2026-10-03', status: 'no-headache' }];
  const summary = summarize(validateState(state, NOW), '2026-09-30', '2026-10-02', NOW);
  assert.equal(summary.headacheDays, 3);
  assert.equal(summary.noHeadacheDays, 0);
  assert.equal(summary.unknownDays, 0);
  assert.equal(summary.attackCount, 2);
  assert.equal(summary.dateOnlyCount, 1);
  assert.equal(summary.overlapCount, 3);
  assert.equal(summary.severeDays, 2);
  assert.equal(summary.meanPain, 19 / 3);
  assert.equal(summary.medicationDays, 2);
  assert.deepEqual(summary.monthly, [
    {
      month: '2026-09', headacheDays: 1, medicationDays: 1, confirmedDays: 1,
      recordCount: 1, attackCount: 1, dateOnlyCount: 0,
      totalDays: 1, unknownDays: 0, noHeadacheDays: 0,
      fromDay: '2026-09-30', toDay: '2026-09-30', partialMonth: true,
    },
    {
      month: '2026-10', headacheDays: 2, medicationDays: 1, confirmedDays: 2,
      recordCount: 2, attackCount: 1, dateOnlyCount: 1,
      totalDays: 2, unknownDays: 0, noHeadacheDays: 0,
      fromDay: '2026-10-01', toDay: '2026-10-02', partialMonth: true,
    },
  ]);
  assert.deepEqual(summary.medications.find((row) => row.name === '药 A'), { name: '药 A', doses: 3, reliefKnown: 3, goodRelief: 1, days: 2 });
  assert.deepEqual(summary.medications.find((row) => row.name === '药 B'), { name: '药 B', doses: 1, reliefKnown: 0, goodRelief: 0, days: 1 });
  assert.deepEqual(summary.dayDetails.map((day) => day.medication), [true, true, false]);
  assert.deepEqual(summary.dayDetails.map((day) => day.pain), [7, 9, 3]);
});

test('several same-day attacks count one headache day and retain the maximum known score regardless of order', () => {
  const start = new Date(2026, 9, 1, 10).toISOString();
  const end = new Date(2026, 9, 1, 11).toISOString();
  const entries = [episode('missing', start, end), episode('zero', start, end, { pain: 0 }), episode('high', start, end, { pain: 9 })];
  for (const order of [entries, [...entries].reverse(), [entries[1], entries[0], entries[2]]]) {
    const summary = summarize(stateWith(...order), '2026-10-01', '2026-10-01', NOW);
    assert.equal(summary.headacheDays, 1);
    assert.equal(summary.attackCount, 3);
    assert.equal(summary.dayDetails[0].pain, 9);
    assert.equal(summary.knownPainCount, 2);
    assert.equal(summary.meanPain, 4.5);
    assert.equal(summary.severeDays, 1);
  }
});

test('daily and monthly record counts include two same-day records and date-only records while preserving unknown days', () => {
  const local = (day, hour = 0) => new Date(2026, 9, day, hour).toISOString();
  const state = validateState(stateWith(
    episode('first-same-day', local(1, 8), local(1, 9)),
    episode('second-same-day', local(1, 14), local(1, 15), { onsetPrecision: 'approximate' }),
    episode('one-tap-next-day', local(2), null, { onsetPrecision: 'day', endUnknown: true, statusUnknown: true }),
  ), NOW);
  state.days = [{ date: '2026-10-03', status: 'no-headache' }];
  const summary = summarize(state, '2026-10-01', '2026-10-04', NOW);
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.attackCount, 2);
  assert.equal(summary.dateOnlyCount, 1);
  assert.equal(summary.headacheDays, 2);
  assert.deepEqual(summary.dayDetails.map(({ date, status, recordCount, carryoverCount }) => ({ date, status, recordCount, carryoverCount })), [
    { date: '2026-10-01', status: 'headache', recordCount: 2, carryoverCount: 0 },
    { date: '2026-10-02', status: 'headache', recordCount: 1, carryoverCount: 0 },
    { date: '2026-10-03', status: 'no-headache', recordCount: 0, carryoverCount: 0 },
    { date: '2026-10-04', status: 'unknown', recordCount: 0, carryoverCount: 0 },
  ]);
  assert.deepEqual(summary.monthly, [{
    month: '2026-10', headacheDays: 2, medicationDays: 0, confirmedDays: 3,
    recordCount: 3, attackCount: 2, dateOnlyCount: 1,
    totalDays: 4, unknownDays: 1, noHeadacheDays: 1,
    fromDay: '2026-10-01', toDay: '2026-10-04', partialMonth: true,
  }]);
});

test('a cross-month headache adds one onset record and separate carryover days without duplicate monthly counts', () => {
  const start = new Date(2026, 8, 30, 23).toISOString();
  const end = new Date(2026, 9, 2, 12).toISOString();
  const state = validateState(stateWith(episode('across-month', start, end)), NOW);
  const summary = summarize(state, '2026-09-30', '2026-10-03', NOW);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.attackCount, 1);
  assert.equal(summary.headacheDays, 3);
  assert.deepEqual(summary.dayDetails.map(({ status, recordCount, carryoverCount }) => [status, recordCount, carryoverCount]), [
    ['headache', 1, 0], ['headache', 0, 1], ['headache', 0, 1], ['unknown', 0, 0],
  ]);
  assert.deepEqual(summary.monthly.map(({ month, recordCount, attackCount, headacheDays }) => ({ month, recordCount, attackCount, headacheDays })), [
    { month: '2026-09', recordCount: 1, attackCount: 1, headacheDays: 1 },
    { month: '2026-10', recordCount: 0, attackCount: 0, headacheDays: 2 },
  ]);
  const clipped = summarize(state, '2026-10-01', '2026-10-02', NOW);
  assert.equal(clipped.recordCount, 0);
  assert.equal(clipped.attackCount, 0);
  assert.equal(clipped.headacheDays, 2);
  assert.deepEqual(clipped.dayDetails.map(({ recordCount, carryoverCount }) => [recordCount, carryoverCount]), [[0, 1], [0, 1]]);
  assert.equal(clipped.monthly[0].recordCount, 0);
  assert.equal(clipped.monthly[0].unknownDays, 0);
});

test('known midnight endings exclude the following day from carryover counts', () => {
  const start = new Date(2026, 8, 30, 23).toISOString();
  const end = new Date(2026, 9, 2, 0).toISOString();
  const summary = summarize(stateWith(episode('midnight-end', start, end)), '2026-09-30', '2026-10-02', NOW);
  assert.deepEqual(summary.dayDetails.map(({ status, recordCount, carryoverCount }) => [status, recordCount, carryoverCount]), [
    ['headache', 1, 0], ['headache', 0, 1], ['unknown', 0, 0],
  ]);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.monthly[1].headacheDays, 1);
});

test('a real ongoing headache across New Year keeps one onset and counts only confirmed carryover through now', () => {
  const start = new Date(2025, 11, 31, 22).toISOString();
  const now = new Date(2026, 0, 2, 12);
  const state = validateState(stateWith(episode('new-year-ongoing', start, null, { onsetPrecision: 'approximate' })), now);
  const summary = summarize(state, '2025-12-31', '2026-01-03', now);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.attackCount, 1);
  assert.equal(summary.ongoingCount, 1);
  assert.deepEqual(summary.dayDetails.map(({ status, recordCount, carryoverCount }) => [status, recordCount, carryoverCount]), [
    ['headache', 1, 0], ['headache', 0, 1], ['headache', 0, 1], ['unknown', 0, 0],
  ]);
  assert.deepEqual(summary.monthly.map(({ month, recordCount, headacheDays, unknownDays, totalDays, fromDay, toDay, partialMonth }) => ({ month, recordCount, headacheDays, unknownDays, totalDays, fromDay, toDay, partialMonth })), [
    { month: '2025-12', recordCount: 1, headacheDays: 1, unknownDays: 0, totalDays: 1, fromDay: '2025-12-31', toDay: '2025-12-31', partialMonth: true },
    { month: '2026-01', recordCount: 0, headacheDays: 2, unknownDays: 1, totalDays: 3, fromDay: '2026-01-01', toDay: '2026-01-03', partialMonth: true },
  ]);
});

test('month coverage distinguishes full months, partial boundary months, leap years, and unknown days across years', () => {
  const state = emptyState();
  state.days = [{ date: '2025-12-31', status: 'no-headache' }];
  const full = summarize(state, '2025-12-01', '2026-01-31', NOW);
  assert.deepEqual(full.monthly.map(({ month, totalDays, unknownDays, noHeadacheDays, partialMonth, fromDay, toDay }) => ({ month, totalDays, unknownDays, noHeadacheDays, partialMonth, fromDay, toDay })), [
    { month: '2025-12', totalDays: 31, unknownDays: 30, noHeadacheDays: 1, partialMonth: false, fromDay: '2025-12-01', toDay: '2025-12-31' },
    { month: '2026-01', totalDays: 31, unknownDays: 31, noHeadacheDays: 0, partialMonth: false, fromDay: '2026-01-01', toDay: '2026-01-31' },
  ]);
  const boundaries = summarize(emptyState(), '2025-12-30', '2026-02-02', NOW);
  assert.deepEqual(boundaries.monthly.map(({ month, totalDays, partialMonth }) => [month, totalDays, partialMonth]), [
    ['2025-12', 2, true], ['2026-01', 31, false], ['2026-02', 2, true],
  ]);
  for (const [year, days] of [[1900, 28], [2000, 29], [2024, 29], [2025, 28]]) {
    const february = summarize(emptyState(), `${year}-02-01`, `${year}-02-${days}`, NOW).monthly[0];
    assert.equal(february.totalDays, days);
    assert.equal(february.unknownDays, days);
    assert.equal(february.noHeadacheDays, 0);
    assert.equal(february.recordCount, 0);
    assert.equal(february.partialMonth, false);
  }
  const leapBoundary = summarize(emptyState(), '2024-02-29', '2024-03-01', NOW);
  assert.deepEqual(leapBoundary.monthly.map(({ fromDay, toDay, totalDays, partialMonth }) => [fromDay, toDay, totalDays, partialMonth]), [
    ['2024-02-29', '2024-02-29', 1, true], ['2024-03-01', '2024-03-01', 1, true],
  ]);
});

test('daily and monthly record counts use the local onset date rather than the UTC date of the stored timestamp', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { emptyState, summarize } from ${JSON.stringify(new URL('../model.js', import.meta.url).href)};
    const state = { ...emptyState(), entries: [{ id: 'utc-boundary', start: '2026-09-30T18:30:00.000Z', end: '2026-09-30T19:30:00.000Z', endUnknown: false, onsetPrecision: 'exact', pain: null, medications: [] }] };
    const summary = summarize(state, '2026-09-30', '2026-10-01', new Date('2026-10-04T04:00:00.000Z'));
    assert.equal(new Date(state.entries[0].start).getDate(), 1);
    assert.deepEqual(summary.dayDetails.map(({ date, status, recordCount, carryoverCount }) => [date, status, recordCount, carryoverCount]), [
      ['2026-09-30', 'unknown', 0, 0], ['2026-10-01', 'headache', 1, 0],
    ]);
    assert.deepEqual(summary.monthly.map(({ month, recordCount, attackCount }) => [month, recordCount, attackCount]), [['2026-09', 0, 0], ['2026-10', 1, 1]]);
    assert.equal(summary.recordCount, 1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' }, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('duration median handles odd and even samples, including a genuine zero-length record', () => {
  const start = new Date(2026, 9, 1, 8).toISOString();
  const entries = [1, 2, 9].map((hours) => episode(`duration-${hours}`, start, new Date(Date.parse(start) + hours * 3_600_000).toISOString()));
  assert.equal(summarize(stateWith(...entries), '2026-10-01', '2026-10-01', NOW).medianDurationHours, 2);
  const zero = episode('duration-zero', start, start);
  const withZero = summarize(stateWith(...entries, zero), '2026-10-01', '2026-10-01', NOW);
  assert.equal(withZero.medianDurationHours, 1.5);
  assert.equal(withZero.knownDurationCount, 4);
  const zeroOnly = summarize(stateWith(zero), '2026-10-01', '2026-10-01', NOW);
  assert.equal(zeroOnly.headacheDays, 1);
  assert.equal(zeroOnly.medianDurationHours, 0);
});

test('date-only future days remain forbidden at midnight despite the timestamp clock tolerance', () => {
  const now = new Date(2026, 9, 3, 23, 58);
  const tomorrow = new Date(2026, 9, 4, 0, 0).toISOString();
  assert.throws(() => validateState(stateWith(episode('future-date-only', tomorrow, null, { onsetPrecision: 'day', endUnknown: true })), now), /未来日期/);
  assert.throws(() => validateState({ ...emptyState(), days: [{ date: '2026-10-04', status: 'no-headache' }] }, now), /未来日期/);
});

test('future onset calendar dates are rejected for both ongoing and completed records at midnight', () => {
  const now = new Date(2026, 9, 3, 23, 58);
  const tomorrow = new Date(2026, 9, 4, 0, 0).toISOString();
  const tomorrowEnd = new Date(2026, 9, 4, 0, 1).toISOString();
  assert.throws(() => validateState(stateWith(episode('future-active-day', tomorrow)), now), /开始日期不能填写未来日期/);
  assert.throws(() => validateState(stateWith(episode('future-completed-day', tomorrow, tomorrowEnd)), now), /开始日期不能填写未来日期/);
  assert.deepEqual(coveredDays(episode('invalid-cross-midnight-active', tomorrow), '2026-10-03', '2026-10-04', now), []);
  const startToday = new Date(2026, 9, 3, 23, 57).toISOString();
  const completed = stateWith(episode('completed-small-clock-difference', startToday, tomorrowEnd));
  assert.doesNotThrow(() => validateState(completed, now));
  assert.equal(completed.entries[0].end, tomorrowEnd);
});

test('same-day tolerated clock differences still confirm an ongoing headache without changing stored start time', () => {
  const now = new Date(2026, 9, 4, 10, 0);
  const start = new Date(now.getTime() + 5 * 60_000).toISOString();
  const input = stateWith(episode('clock-difference', start));
  input.days = [{ date: '2026-10-04', status: 'no-headache' }];
  const state = validateState(input, now);
  const snapshot = structuredClone(state);
  assert.deepEqual(coveredDays(state.entries[0], '2026-10-04', '2026-10-04', now), ['2026-10-04']);
  const summary = summarize(state, '2026-10-04', '2026-10-04', now);
  assert.equal(summary.headacheDays, 1);
  assert.equal(summary.noHeadacheDays, 0);
  assert.equal(summary.unknownDays, 0);
  assert.equal(summary.attackCount, 1);
  assert.equal(summary.ongoingCount, 1);
  assert.equal(summary.knownDurationCount, 0);
  assert.deepEqual(state, snapshot);
  const outsideTolerance = episode('invalid-later-start', new Date(now.getTime() + 5 * 60_000 + 1).toISOString());
  assert.deepEqual(coveredDays(outsideTolerance, '2026-10-04', '2026-10-04', now), []);
});

test('all timestamp fields enforce exactly five minutes of clock tolerance', () => {
  const now = new Date(2026, 9, 4, 12, 0, 0);
  const limit = new Date(now.getTime() + 5 * 60_000).toISOString();
  const over = new Date(now.getTime() + 5 * 60_000 + 1).toISOString();
  const start = new Date(2026, 9, 4, 10).toISOString();
  assert.doesNotThrow(() => validateState(stateWith(episode('limit-start', limit)), now));
  const bases = [
    (timestamp) => episode('future-start', timestamp),
    (timestamp) => episode('future-end', start, timestamp),
    (timestamp) => episode('future-created', start, null, { createdAt: timestamp }),
    (timestamp) => episode('future-updated', start, null, { updatedAt: timestamp }),
    (timestamp) => episode('future-dose', start, null, { medications: [{ id: 'future-dose-id', name: '药物', dose: '', at: timestamp, relief: null }] }),
  ];
  for (const make of bases) {
    assert.doesNotThrow(() => validateState(stateWith(make(limit)), now));
    assert.throws(() => validateState(stateWith(make(over)), now), /不能晚于现在/);
  }
});

test('strict imported dates reject impossible Gregorian leap dates, invalid zones, and unsupported normalized years', () => {
  const invalid = [
    '1900-02-29T12:00:00Z', '2026-04-31T12:00:00Z', '2026-00-01T12:00:00Z',
    '2026-01-00T12:00:00Z', '2026-10-01T12:60:00Z', '2026-10-01T12:00:60Z',
    '2026-10-01T12:00:00+15:00', '2026-10-01T12:00:00+14:01',
    '2026-10-01T12:00:00+08:60', '0001-01-01T00:00:00+14:00',
  ];
  for (const start of invalid) assert.throws(() => validateState(stateWith(episode('invalid-time', start)), NOW), Error, start);
  const valid = ['2000-02-29T12:00:00Z', '2024-02-29T12:00:00+14:00', '2026-10-01T12:00:00.123-12:00'];
  for (const start of valid) {
    const normalized = validateState(stateWith(episode('valid-time', start)), NOW);
    assert.equal(normalized.entries[0].start, new Date(start).toISOString());
    assert.deepEqual(validateState(normalized, NOW), normalized);
  }
});

test('import validation preserves explicit empty selections and rejects wrong types, overlong fields, and cross-entry dose duplicates', () => {
  const start = instant('2026-10-01'), end = instant('2026-10-01', '13:00:00');
  const base = episode('base', start, end, { symptoms: [], triggers: [], locations: [], character: [] });
  const normalized = validateState(stateWith(base), NOW);
  for (const field of ['symptoms', 'triggers', 'locations', 'character']) assert.deepEqual(normalized.entries[0][field], []);
  const invalidFields = [
    { pain: true }, { pain: 1.5 }, { pain: -1 }, { pain: 11 }, { endUnknown: 'false' },
    { onsetPrecision: 'certain' }, { impact: 'none' }, { menstruation: 'sometimes' },
    { symptoms: '恶心' }, { triggers: [null] }, { character: [''] },
    { notes: '字'.repeat(4001) }, { symptoms: ['字'.repeat(81)] },
    { triggers: Array.from({ length: 101 }, (_, index) => `诱因 ${index}`) },
  ];
  for (const fields of invalidFields) assert.throws(() => validateState(stateWith({ ...base, ...fields }), NOW), Error, JSON.stringify(fields).slice(0, 100));
  const dose = { id: 'same-dose', name: '药物', dose: '', at: start, relief: null };
  assert.throws(() => validateState(stateWith({ ...base, medications: [dose] }, episode('other', start, end, { medications: [dose] })), NOW), /用药编号重复/);
  assert.throws(() => validateState({ ...emptyState(), profile: { ...emptyState().profile, medications: [{ name: ' 药物 ', dose: '' }, { name: '药物', dose: '' }] } }, NOW), /常用药含重复项/);
  assert.throws(() => validateState({ ...emptyState(), revision: Number.MAX_SAFE_INTEGER + 1 }, NOW), /修订号/);
});

test('summarizing and validating do not mutate frozen patient data or its ordering', () => {
  const start = new Date(2026, 9, 1, 10).toISOString(), end = new Date(2026, 9, 1, 12).toISOString();
  const state = stateWith(episode('later', new Date(2026, 9, 2, 10).toISOString(), new Date(2026, 9, 2, 12).toISOString()), episode('first', start, end, { symptoms: ['恶心'], triggers: [] }));
  const before = structuredClone(state);
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(state);
  const normalized = validateState(state, NOW);
  const summary = summarize(state, '2026-10-01', '2026-10-03', NOW);
  assert.deepEqual(state, before);
  assert.deepEqual(summary.entries.map((entry) => entry.id), ['first', 'later']);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(normalized)), NOW), normalized);
});

test('calendar coverage remains correct through spring and autumn daylight-saving transitions', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { emptyState, summarize, dateRangeDays } from ${JSON.stringify(new URL('../model.js', import.meta.url).href)};
    assert.equal(new Date(2026, 2, 7).getTimezoneOffset(), 300);
    assert.equal(new Date(2026, 2, 9).getTimezoneOffset(), 240);
    for (const [month, day, from, to, nowDay, duration] of [
      [2, 7, '2026-03-07', '2026-03-09', 10, 24],
      [9, 31, '2026-10-31', '2026-11-02', 34, 26],
    ]) {
      const start = new Date(2026, month, day, 23).toISOString();
      const end = new Date(2026, month, day + 2, 0).toISOString();
      const state = { ...emptyState(), entries: [{ id: 'dst', start, end, endUnknown: false, pain: 5, medications: [] }] };
      const summary = summarize(state, from, to, new Date(2026, month, nowDay));
      assert.equal(dateRangeDays(from, to).length, 3);
      assert.equal(summary.headacheDays, 2);
      assert.equal(summary.dayDetails[2].status, 'unknown');
      assert.equal(summary.medianDurationHours, duration);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' }, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('multiple report ranges agree with an independent per-day interval-overlap oracle', () => {
  let seed = 754291;
  const next = (maximum) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const entries = [];
  for (let index = 0; index < 40; index++) {
    const start = new Date(2026, 8, 1 + next(28), next(24), next(60)).toISOString();
    const durationHours = [0, 1, 23, 24, 25, 48][next(6)];
    const end = new Date(Date.parse(start) + durationHours * 3_600_000).toISOString();
    const unknown = index % 7 === 0, dateOnly = index % 9 === 0;
    const entry = episode(`oracle-${index}`, start, unknown || dateOnly ? null : end, {
      endUnknown: unknown || dateOnly,
      onsetPrecision: dateOnly ? 'day' : 'exact',
      pain: [null, 0, 3, 7, 10][next(5)],
    });
    if (index % 3 === 0) entry.medications = [0, 2].map((hours, doseIndex) => ({
      id: `oracle-dose-${index}-${doseIndex}`, name: `药 ${index % 2}`, dose: '',
      at: new Date(Date.parse(start) + hours * 3_600_000).toISOString(), relief: doseIndex ? 'good' : null,
    }));
    entries.push(entry);
  }
  const now = new Date(2026, 8, 30, 12);
  entries.push(episode('oracle-active', new Date(2026, 8, 29, 10).toISOString(), null, { pain: 6 }));
  const state = stateWith(...entries);
  const markedNoHeadache = new Set([5, 10, 15, 20, 25, 30]);
  state.days = [...markedNoHeadache].map((day) => ({ date: `2026-09-${String(day).padStart(2, '0')}`, status: 'no-headache' }));
  validateState(state, new Date(2026, 9, 4, 12));
  const intersects = (entry, day) => {
    const dayStart = new Date(2026, 8, day).getTime(), nextDay = new Date(2026, 8, day + 1).getTime();
    const start = Date.parse(entry.start);
    if (entry.endUnknown || entry.onsetPrecision === 'day' || entry.end === entry.start) return start >= dayStart && start < nextDay;
    if (!entry.end) return start <= now.getTime() && start < nextDay && now.getTime() >= dayStart;
    return start < nextDay && Date.parse(entry.end) > dayStart;
  };
  for (const [first, last] of [[1, 30], [1, 1], [1, 5], [5, 12], [10, 18], [20, 30], [29, 30]]) {
    const from = `2026-09-${String(first).padStart(2, '0')}`, to = `2026-09-${String(last).padStart(2, '0')}`;
    const summary = summarize(state, from, to, now);
    const expectedDays = Array.from({ length: last - first + 1 }, (_, index) => {
      const day = first + index, date = `2026-09-${String(day).padStart(2, '0')}`;
      const dayStart = new Date(2026, 8, day).getTime(), nextDay = new Date(2026, 8, day + 1).getTime();
      const matches = entries.filter((entry) => intersects(entry, day));
      const painValues = matches.filter((entry) => entry.pain !== null).map((entry) => entry.pain);
      return {
        date,
        status: matches.length ? 'headache' : markedNoHeadache.has(day) ? 'no-headache' : 'unknown',
        pain: painValues.length ? Math.max(...painValues) : null,
        medication: entries.some((entry) => entry.medications.some((dose) => Date.parse(dose.at) >= dayStart && Date.parse(dose.at) < nextDay)),
        recordCount: entries.filter((entry) => Date.parse(entry.start) >= dayStart && Date.parse(entry.start) < nextDay).length,
        carryoverCount: matches.filter((entry) => entry.onsetPrecision !== 'day' && entry.statusUnknown !== true && Date.parse(entry.start) < dayStart).length,
      };
    });
    const overlapping = entries.filter((entry) => Array.from({ length: last - first + 1 }, (_, index) => first + index).some((day) => intersects(entry, day)));
    assert.deepEqual(summary.dayDetails, expectedDays, `${from} — ${to}`);
    assert.equal(summary.headacheDays, expectedDays.filter((day) => day.status === 'headache').length);
    assert.equal(summary.noHeadacheDays, expectedDays.filter((day) => day.status === 'no-headache').length);
    assert.equal(summary.unknownDays, expectedDays.filter((day) => day.status === 'unknown').length);
    assert.equal(summary.medicationDays, expectedDays.filter((day) => day.medication).length);
    assert.equal(summary.severeDays, expectedDays.filter((day) => day.pain !== null && day.pain >= 7).length);
    assert.equal(summary.headacheDays + summary.noHeadacheDays + summary.unknownDays, last - first + 1);
    assert.deepEqual(summary.entries.map((entry) => entry.id).sort(), overlapping.map((entry) => entry.id).sort());
    assert.equal(summary.dateOnlyCount, overlapping.filter((entry) => entry.onsetPrecision === 'day').length);
    const onsetFrom = new Date(2026, 8, first).getTime(), onsetTo = new Date(2026, 8, last + 1).getTime();
    assert.equal(summary.attackCount, entries.filter((entry) => entry.onsetPrecision !== 'day' && Date.parse(entry.start) >= onsetFrom && Date.parse(entry.start) < onsetTo).length);
    assert.equal(summary.recordCount, entries.filter((entry) => Date.parse(entry.start) >= onsetFrom && Date.parse(entry.start) < onsetTo).length);
    assert.equal(summary.recordCount, summary.dayDetails.reduce((total, day) => total + day.recordCount, 0));
    assert.equal(summary.recordCount, summary.monthly.reduce((total, month) => total + month.recordCount, 0));
  }
});

test('two thousand patient records remain practical to validate and summarize', { timeout: 10_000 }, (context) => {
  const entries = Array.from({ length: 2000 }, (_, index) => {
    const start = new Date(2024, 0, 1 + index % 900, 10).toISOString();
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    return episode(`large-${index}`, start, end, { pain: index % 11, medications: [{ id: `large-dose-${index}`, name: `药 ${index % 3}`, dose: '1 片', at: start, relief: null }] });
  });
  const now = new Date(2026, 9, 4, 12);
  const beforeValidation = performance.now();
  const state = validateState(stateWith(...entries), now);
  const validationMs = performance.now() - beforeValidation;
  const beforeSummary = performance.now();
  const summary = summarize(state, '2024-01-01', '2026-10-04', now);
  const summaryMs = performance.now() - beforeSummary;
  assert.equal(summary.attackCount, 2000);
  assert.equal(summary.overlapCount, 2000);
  assert.equal(summary.headacheDays, 900);
  assert.equal(summary.medicationDays, 900);
  assert.equal(summary.knownDurationCount, 2000);
  assert.equal(summary.medianDurationHours, 1);
  assert.equal(summary.medications.reduce((sum, row) => sum + row.doses, 0), 2000);
  context.diagnostic(`2000 条记录：校验 ${validationMs.toFixed(1)} ms；完整 1008 天汇总 ${summaryMs.toFixed(1)} ms。此计时不替代浏览器操作或磁盘保存耗时。`);
});

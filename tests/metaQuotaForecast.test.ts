import { describe, expect, test } from 'bun:test';
import { parseMetaQuotaPayload } from '@/services/api/metaQuota';
import { buildQuotaForecast } from '@/features/quota/forecast/forecastModel';
import {
  meterForWindow,
  resolveMeterRate,
  windowOfMeter,
} from '@/features/quota/forecast/forecastWindows';
import { isPrimaryWindow, readQuotaMeters } from '@/features/quota/forecast/quotaMeters';
import { activePollTargets, type QuotaFileEntry } from '@/features/quota/logic';
import type { AuthFileItem, MetaQuotaState } from '@/types';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Shape of the live hub's Muse key response (identifying fields left out). */
const LIVE_RESPONSE = {
  subs_tier_name: 'Muse Pro',
  is_subs_active: true,
  subs_usage: {
    window: { used_percent: 30, window_duration_mins: 300, resets_at: 1795011911 },
    weekly: { used_percent: 52, resets_at: 1795392000 },
  },
};
const SESSION_RESET_MS = 1795011911 * 1000;
const WEEKLY_RESET_MS = 1795392000 * 1000;

const stateOf = (payload: unknown): MetaQuotaState => {
  const data = parseMetaQuotaPayload(payload);
  if (!data) throw new Error('fixture must parse');
  return { status: 'success', data };
};

describe('Meta quota in the forecast', () => {
  test('the Muse 5-hour window is the session window and weekly the primary window', () => {
    const meters = readQuotaMeters('meta', stateOf(LIVE_RESPONSE));

    const session = meterForWindow(meters, 'session');
    expect(session).toMatchObject({
      remaining: 70,
      resetAtMs: SESSION_RESET_MS,
      periodHours: 5,
      primary: false,
    });
    expect(session && windowOfMeter(session)).toBe('session');

    const weekly = meterForWindow(meters, 'weekly');
    expect(weekly).toMatchObject({
      remaining: 48,
      resetAtMs: WEEKLY_RESET_MS,
      periodHours: 168,
      primary: true,
    });
    expect(weekly && windowOfMeter(weekly)).toBe('weekly');
    // Server-side history readings of that window join the weekly forecast too.
    expect(weekly && isPrimaryWindow('meta', weekly.id)).toBe(true);
  });

  test('a session window that burns at its pace runs out before its reset', () => {
    // One hour into the 5-hour window with 30% used: 30%/h, 70% left -> 2h20m.
    const nowMs = SESSION_RESET_MS - 4 * HOUR_MS;
    const meter = meterForWindow(readQuotaMeters('meta', stateOf(LIVE_RESPONSE)), 'session');
    if (!meter) throw new Error('expected a session meter');
    const rate = resolveMeterRate(meter, [], nowMs, 3 * HOUR_MS);
    expect(rate.ratePerHour).toBeCloseTo(30, 6);

    const forecast = buildQuotaForecast({
      live: [
        {
          credentialId: 'muse',
          remaining: meter.remaining,
          resetAtMs: meter.resetAtMs,
          periodHours: meter.periodHours,
          ratePerHour: rate.ratePerHour,
          averagePerHour: rate.averagePerHour,
        },
      ],
      history: [],
      nowMs,
      rangeMs: 24 * HOUR_MS,
      lookbackMs: 3 * HOUR_MS,
      enoughMs: 30 * MINUTE_MS,
    });
    expect(forecast.remaining).toBe(70);
    expect(forecast.firstRunsOutAtMs).toBeCloseTo(nowMs + 140 * MINUTE_MS, -3);
  });

  test('unknown usage adds no meter instead of reading as empty or full', () => {
    const meters = readQuotaMeters(
      'meta',
      stateOf({ subs_usage: { window: { window_duration_mins: 300 }, weekly: {} } })
    );
    expect(meters).toEqual([]);
  });

  test('an idle short window is a full 5-hour meter with no reset, and weekly stays out', () => {
    // Meta sends no subs_usage while no 5-hour window is open.
    const meters = readQuotaMeters('meta', stateOf({ is_subs_active: true }));
    expect(meters.map(({ id, remaining, resetAtMs }) => ({ id, remaining, resetAtMs }))).toEqual([
      { id: 'five-hour', remaining: 100, resetAtMs: null },
    ]);
  });

  test('a short window of another length is not filed as the 5-hour window', () => {
    const meters = readQuotaMeters(
      'meta',
      stateOf({
        subs_usage: {
          window: { used_percent: 10, window_duration_mins: 240, resets_at: 1795011911 },
        },
      })
    );
    expect(meterForWindow(meters, 'session')).toBeUndefined();
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({ remaining: 90, periodHours: 4 });
  });
});

describe('background poll of providers without a passive snapshot', () => {
  const NOW_MS = Date.parse('2099-01-01T12:00:00Z');
  const INTERVAL_MS = 2 * MINUTE_MS;
  const entry = (name: string, type: QuotaFileEntry['type']): QuotaFileEntry => ({
    file: { name } as AuthFileItem,
    type,
  });

  const cases: {
    name: string;
    entry: QuotaFileEntry;
    status?: string;
    lastMs: number | null;
    due: boolean;
  }[] = [
    { name: 'Meta never read', entry: entry('muse', 'meta'), lastMs: null, due: true },
    {
      name: 'Meta read one interval ago',
      entry: entry('muse', 'meta'),
      status: 'success',
      lastMs: NOW_MS - INTERVAL_MS,
      due: true,
    },
    {
      name: 'Meta read a moment ago',
      entry: entry('muse', 'meta'),
      status: 'success',
      lastMs: NOW_MS - 30_000,
      due: false,
    },
    {
      name: 'Meta read in flight',
      entry: entry('muse', 'meta'),
      status: 'loading',
      lastMs: null,
      due: false,
    },
    // Claude and Codex come from the credential list's passive snapshot.
    { name: 'Claude', entry: entry('claude-a', 'claude'), lastMs: null, due: false },
    { name: 'Codex', entry: entry('codex-a', 'codex'), lastMs: null, due: false },
  ];

  test.each(cases)('$name: due=$due', ({ entry: target, status, lastMs, due }) => {
    const targets = activePollTargets(
      [target],
      () => status,
      () => lastMs,
      NOW_MS,
      INTERVAL_MS
    );
    expect(targets.length > 0).toBe(due);
  });
});

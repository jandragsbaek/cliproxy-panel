/**
 * Flat per-credential meter readings for the ledger, the provider group totals
 * and the history recorder.
 *
 * Claude, Codex and Devin carry labelled windows with reset instants; Meta's
 * two windows map onto the same ids (5-hour session window `five-hour`, weekly
 * `weekly`); the other providers are read through `buildTimelineLane`, which
 * already knows their shapes. Pure and React-free.
 */

import type { TFunction } from 'i18next';
import { META_SESSION_MINUTES } from '@/services/api/metaQuota';
import { buildTimelineLane } from '../quotaTimelineModel';
import type { QuotaProviderType } from '../providers/types';

export const WEEK_HOURS = 168;

export interface QuotaMeterReading {
  id: string;
  label: string;
  /** i18n key for the label, when the provider supplied one. */
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Remaining percent, 0..100. */
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
  /** The weekly account window that drives the forecast. */
  primary: boolean;
}

interface WindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/**
 * Weekly account window id per provider; model-scoped weeklies are not primary.
 * xAI has a single timeline window, filed as `window`.
 */
const PRIMARY_WINDOW_ID: Partial<Record<QuotaProviderType, string>> = {
  claude: 'seven-day',
  codex: 'weekly',
  meta: 'weekly',
  xai: 'window',
};

/** Whether a window is its provider's weekly account window. */
export const isPrimaryWindow = (provider: QuotaProviderType, windowId: string) =>
  PRIMARY_WINDOW_ID[provider] === windowId;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));
const finiteOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function readQuotaMeters(provider: QuotaProviderType, quota: unknown): QuotaMeterReading[] {
  // Loading states keep the previous read (Claude retains its windows, Meta
  // its data); other providers' loading states are empty and read as no meters.
  const state = quota as { status?: string } | undefined;
  if (!state || (state.status !== 'success' && state.status !== 'loading')) return [];

  if (provider === 'claude' || provider === 'codex' || provider === 'devin') {
    const windows = (quota as { windows?: WindowLike[] }).windows ?? [];
    const meters = windows
      .map((window, index): QuotaMeterReading | null => {
        const remaining =
          provider === 'devin'
            ? finiteOrNull(window.remainingPercent)
            : finiteOrNull(window.usedPercent) === null
              ? null
              : 100 - (window.usedPercent as number);
        if (remaining === null) return null;
        return {
          id: window.id || `window-${index}`,
          label: window.label ?? window.id ?? '',
          labelKey: window.labelKey,
          labelParams: window.labelParams,
          remaining: clampPercent(remaining),
          resetAtMs: finiteOrNull(window.resetAtMs),
          periodHours: finiteOrNull(window.periodHours),
          primary: false,
        };
      })
      .filter((meter): meter is QuotaMeterReading => meter !== null);
    return markPrimary(meters, PRIMARY_WINDOW_ID[provider]);
  }

  if (provider === 'meta') return markPrimary(readMetaMeters(quota), PRIMARY_WINDOW_ID.meta);

  // Other providers: the lane reader knows their shapes; its chosen window
  // (longest that fits a week) is the one with a known reset instant.
  const lane = buildTimelineLane({
    name: '',
    displayName: '',
    provider,
    quota: state,
    maxPeriodHours: WEEK_HOURS,
  });
  const meters: QuotaMeterReading[] = lane.limits.map((limit, index) => ({
    id: `limit-${index}`,
    label: limit.label,
    remaining: limit.remaining,
    resetAtMs: null,
    periodHours: null,
    primary: false,
  }));
  if (lane.anchorMs !== null && lane.remaining !== null) {
    const chosen = meters.find((meter) => meter.remaining === lane.remaining);
    const reading = {
      resetAtMs: lane.anchorMs,
      periodHours: lane.periodHours,
      primary: (lane.periodHours ?? 0) >= 24,
    };
    if (chosen) Object.assign(chosen, reading);
    else meters.unshift({ id: 'window', label: '', remaining: lane.remaining, ...reading });
  }
  return meters;
}

interface MetaWindowLike {
  id?: string;
  usedPercent?: number | null;
  /** Unix seconds. */
  resetAt?: number;
  durationMinutes?: number;
}

/**
 * Meta's Muse key endpoint reports a short `window` (with its length, 300
 * minutes today) and a `weekly` window (no length; it is seven days). The
 * short one files as the 5-hour session window when it is five hours long, so
 * the forecast, the history and the rate rules treat it like Claude's and
 * Codex's. Windows with unknown usage are left out, not read as 0 or 100.
 */
function readMetaMeters(quota: unknown): QuotaMeterReading[] {
  const windows = (quota as { data?: { windows?: MetaWindowLike[] } }).data?.windows ?? [];
  return windows
    .map((window): QuotaMeterReading | null => {
      const used = finiteOrNull(window.usedPercent);
      if (used === null) return null;
      const resetAt = finiteOrNull(window.resetAt);
      const resetAtMs = resetAt !== null && resetAt > 0 ? resetAt * 1000 : null;
      if (window.id === 'weekly') {
        return {
          id: 'weekly',
          label: 'meta_quota.weekly',
          labelKey: 'meta_quota.weekly',
          remaining: clampPercent(100 - used),
          resetAtMs,
          periodHours: WEEK_HOURS,
          primary: false,
        };
      }
      if (window.id !== 'window') return null;
      const minutes = finiteOrNull(window.durationMinutes) ?? META_SESSION_MINUTES;
      const wholeHours = minutes % 60 === 0;
      return {
        id: minutes === META_SESSION_MINUTES ? 'five-hour' : `window-${minutes}`,
        label: 'meta_quota.window',
        labelKey: wholeHours ? 'meta_quota.window_duration_hours' : 'meta_quota.window_duration',
        labelParams: wholeHours ? { hours: minutes / 60 } : { minutes },
        remaining: clampPercent(100 - used),
        resetAtMs,
        periodHours: minutes / 60,
        primary: false,
      };
    })
    .filter((meter): meter is QuotaMeterReading => meter !== null);
}

/** Prefer the provider's account window; otherwise the soonest-resetting weekly one. */
function markPrimary(meters: QuotaMeterReading[], preferredId?: string): QuotaMeterReading[] {
  const weekly = meters.filter((meter) => (meter.periodHours ?? 0) >= 24 && meter.resetAtMs);
  const primary =
    weekly.find((meter) => meter.id === preferredId) ??
    weekly.sort((a, b) => (a.resetAtMs as number) - (b.resetAtMs as number))[0];
  return meters.map((meter) => (meter === primary ? { ...meter, primary: true } : meter));
}

/** When an exhausted credential gets capacity back, or null when it is not exhausted. */
export function exhaustedUntilMs(meters: QuotaMeterReading[], nowMs: number): number | null {
  const blocking = meters.filter(
    (meter) => meter.remaining <= 0 && meter.resetAtMs !== null && meter.resetAtMs > nowMs
  );
  if (blocking.length === 0) return null;
  return Math.max(...blocking.map((meter) => meter.resetAtMs as number));
}

/** Display label: the provider's i18n key when it gave one, else its own text. */
export const meterLabel = (t: TFunction, meter: QuotaMeterReading): string =>
  meter.labelKey ? String(t(meter.labelKey, meter.labelParams)) : t(meter.label, meter.label);

/** Primary weekly window first, the rest in provider order. */
export const orderedMeters = (meters: QuotaMeterReading[]): QuotaMeterReading[] => [
  ...meters.filter((meter) => meter.primary),
  ...meters.filter((meter) => !meter.primary),
];

/**
 * A meter as of `nowMs`: once its reset has passed, the window has refilled.
 * Short (5-hour) windows start again on the next request, so their next reset
 * is unknown; longer ones roll forward by whole periods.
 */
export function meterAsOf(meter: QuotaMeterReading, nowMs: number): QuotaMeterReading {
  if (meter.resetAtMs === null || meter.resetAtMs > nowMs) return meter;
  const periodMs = (meter.periodHours ?? 0) * 3_600_000;
  if (periodMs < 24 * 3_600_000) return { ...meter, remaining: 100, resetAtMs: null };
  let next = meter.resetAtMs;
  while (next <= nowMs) next += periodMs;
  return { ...meter, remaining: 100, resetAtMs: next };
}

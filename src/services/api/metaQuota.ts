import type { MetaQuotaData, MetaQuotaWindow } from '@/types';
import { isRecord } from '@/utils/helpers';

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const parseFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseUsedPercent = (value: unknown): number | null => {
  const percent = parseFiniteNumber(value);
  return percent === null ? null : Math.min(100, Math.max(0, percent));
};

const parsePositiveNumber = (value: unknown): number | undefined => {
  const parsed = parseFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : undefined;
};

const parseWindow = (
  id: MetaQuotaWindow['id'],
  value: unknown,
  includeDuration: boolean
): MetaQuotaWindow => {
  const raw = asRecord(value);
  const resetAt = parsePositiveNumber(raw.resets_at);
  const durationMinutes = includeDuration
    ? parsePositiveNumber(raw.window_duration_mins)
    : undefined;

  return {
    id,
    usedPercent: parseUsedPercent(raw.used_percent),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
  };
};

/** Meta's short window is five hours long today. */
export const META_SESSION_MINUTES = 5 * 60;

/**
 * Parse only fields used by the quota UI. The upstream response may also carry
 * api_key and PII; retaining the source object (or spreading it) here is forbidden.
 *
 * Meta drops `subs_usage` (both windows) while no 5-hour window is open: after
 * one ends and before the next request opens a new one. With an active
 * subscription that reads as an idle short window (nothing used) and an
 * unknown weekly window; `carryMetaWeekly` fills the weekly one from the last
 * reading. Without subscription status, missing usage stays unknown, never 0.
 * Invalid response bodies return null so transport/protocol errors stay distinct.
 */
export function parseMetaQuotaPayload(payload: unknown): MetaQuotaData | null {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;

  const root = payload;
  const usage = asRecord(root.subs_usage);
  const explicitPlan = typeof root.subs_tier_name === 'string' ? root.subs_tier_name.trim() : '';
  const usagePlan = typeof usage.tier === 'string' ? usage.tier.trim() : '';
  const planName = explicitPlan || usagePlan;
  // Omitted, not malformed: a malformed field stays unknown.
  const idle = root.is_subs_active === true && root.subs_usage === undefined;

  return {
    ...(planName ? { planName } : {}),
    ...(typeof root.is_subs_active === 'boolean'
      ? { isSubscriptionActive: root.is_subs_active }
      : {}),
    windows: [
      idle
        ? { id: 'window', usedPercent: 0, durationMinutes: META_SESSION_MINUTES, idle: true }
        : parseWindow('window', usage.window, true),
      parseWindow('weekly', usage.weekly, false),
    ],
  };
}

/**
 * Keep the weekly window through an idle gap: when `next` has no weekly usage
 * but its short window is idle, use the previous weekly reading, marked
 * `lastKnown`, while that reading's reset is still ahead.
 *
 * Every request opens a short window, so weekly use can only have moved inside
 * one. The carry is safe only when no whole window fits between the previous
 * reading and now: it is measured from the end of the previous open window, or
 * from the previous idle reading. Use inside the previous open window after
 * its reading is the one thing it can miss.
 */
export function carryMetaWeekly(
  next: MetaQuotaData,
  previous: MetaQuotaData | undefined,
  nowMs: number
): MetaQuotaData {
  const idle = next.windows.some((window) => window.id === 'window' && window.idle);
  const weeklyIndex = next.windows.findIndex((window) => window.id === 'weekly');
  if (!idle || weeklyIndex === -1 || next.windows[weeklyIndex].usedPercent !== null) return next;

  const short = previous?.windows.find((window) => window.id === 'window');
  const quietSinceMs = short?.idle
    ? previous?.observedAtMs
    : short?.resetAt
      ? short.resetAt * 1000
      : undefined;
  const windowMs = (short?.durationMinutes ?? META_SESSION_MINUTES) * 60_000;
  if (quietSinceMs === undefined || nowMs - quietSinceMs >= windowMs) return next;

  const last = previous?.windows.find((window) => window.id === 'weekly');
  if (!last || last.usedPercent === null || !last.resetAt || last.resetAt * 1000 <= nowMs) {
    return next;
  }
  const windows = [...next.windows];
  windows[weeklyIndex] = { ...last, lastKnown: true };
  return { ...next, windows };
}

/**
 * Background upstream reads for providers without a passive quota snapshot
 * (see ACTIVE_POLL_PROVIDERS), on the same cadence as the credential-list poll.
 * Without it their forecast and history would only move on a manual refresh.
 *
 * Runs every credential of those providers, not just the current page, since
 * the forecast covers all of them. Reads go through the batch loader in
 * background mode, so a row on screen keeps its data while a read runs or
 * fails. The fetchers keep their own secret rules; nothing here sees tokens or
 * response bodies.
 */

import { useEffect, useRef } from 'react';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { QUOTA_POLL_HIDDEN_MS, QUOTA_POLL_MS } from '../constants';
import { activePollTargets, type QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { quotaObservedAt } from './useQuotaCache';

export function useActiveQuotaPoll(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  disabled: boolean,
  loadQuota: (targets: QuotaFileEntry[], options: { keepExisting?: boolean }) => Promise<boolean>
) {
  const latest = useRef({ entries, quotaFor, loadQuota });
  useEffect(() => {
    latest.current = { entries, quotaFor, loadQuota };
  });
  /** When each credential's last background read started. */
  const attemptedAt = useRef(new Map<string, number>());

  useEffect(() => {
    if (disabled) return;
    const pollIfDue = () => {
      const { entries: current, quotaFor: stateOf, loadQuota: load } = latest.current;
      const nowMs = Date.now();
      const interval =
        document.visibilityState === 'visible' ? QUOTA_POLL_MS : QUOTA_POLL_HIDDEN_MS;
      const due = activePollTargets(
        current,
        (entry) => stateOf(entry)?.status,
        (entry) => {
          const observed = quotaObservedAt(stateOf(entry));
          const attempted = attemptedAt.current.get(getQuotaCacheKey(entry.file)) ?? null;
          if (observed === null) return attempted;
          return attempted === null ? observed : Math.max(observed, attempted);
        },
        nowMs,
        interval
      );
      if (due.length === 0) return;
      void load(due, { keepExisting: true }).then((started) => {
        // Another batch held the loader: try again on the next tick.
        if (!started) return;
        due.forEach((entry) => attemptedAt.current.set(getQuotaCacheKey(entry.file), nowMs));
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') pollIfDue();
    };
    pollIfDue();
    const timer = window.setInterval(pollIfDue, QUOTA_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [disabled]);
}

import type { BehavioralEvent } from '@freedms/shared';
export type AnalyticsApi = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
/** The only client analytics transport; failures never affect dealer workflows. */
export async function track(api: AnalyticsApi, event: BehavioralEvent): Promise<void> {
  try { await api('/analytics/events', 'POST', event); } catch { /* Best effort. */ }
}

import type { FeedOptions, Vehicle } from '@freedms/shared';

export const sortedFeedVehicles = (vehicles: Vehicle[]) => [...vehicles].sort((a, b) => a.stockNumber.localeCompare(b.stockNumber) || a.id.localeCompare(b.id));
export const feedExclusion = (v: Vehicle, config: FeedOptions) => !config.includedStatuses.includes(v.status) ? (v.status === 'sold' ? 'sold' : 'status_not_included') : config.requirePrice && v.listPrice <= 0 ? 'missing_price' : null;

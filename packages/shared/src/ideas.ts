import type { CrmRecord, SessionUser } from './index.js';

export const PRODUCT_VERSION = '0.1.0';
export const ideaStatuses = ['Received', 'Under review', 'Accepted', 'Declined', 'Shipped'] as const;
export type IdeaStatus = typeof ideaStatuses[number];
export interface Idea extends CrmRecord {
  submitter: SessionUser;
  title: string;
  description: string;
  surface: string;
  productVersion: string;
  status: IdeaStatus;
  declineReason: string | null;
  shippedNote: string | null;
}
export interface QueuedIdea extends Idea { tenantName: string }
/** Operators may correct any reviewed state; Received is only assigned at submission. */
export function canTransitionIdea(from: IdeaStatus, to: IdeaStatus): boolean {
  return ideaStatuses.includes(from) && ideaStatuses.includes(to) && to !== 'Received';
}

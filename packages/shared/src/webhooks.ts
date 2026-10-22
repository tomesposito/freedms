import type { CrmRecord } from './index.js';
/** Configuration events are deliberately excluded to prevent dispatch loops. */
export const webhookEventTypes = ['feed.configured', 'feed.generated', 'vehicle.imported', 'document.created', 'document.updated', 'deal.created', 'deal.updated', 'settings.created', 'settings.updated', 'vehicle.created', 'vehicle.updated', 'vehicle.deleted', 'tenant.created', 'customer.created', 'customer.updated', 'lead.created', 'lead.updated', 'intake.created', 'intake.updated'] as const;
export type WebhookEventType = typeof webhookEventTypes[number];
export interface WebhookEndpoint extends CrmRecord {
  url: string; eventTypes: WebhookEventType[]; enabled: boolean;
  /** Local storage retains the raw secret because HMAC signing requires it. */
  secret: string;
}
export type PublicWebhookEndpoint = Omit<WebhookEndpoint, 'secret'>;
export interface WebhookDelivery {
  id: string; tenantId: string; endpointId: string; eventId: string; eventType: WebhookEventType;
  status: 'delivered' | 'failed'; attempts: number; lastStatusCode: number | null; lastError: string | null;
  createdAt: string; updatedAt: string;
}

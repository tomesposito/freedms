import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicWebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import { webhookDeliveryHtml, webhookEndpointHtml } from '../src/webhooks.js';
test('webhook HTML escapes malicious URLs and event text, shows terminal states and read-only controls', () => {
  const endpoint: PublicWebhookEndpoint = {id: 'hook', tenantId: 'A', version: 1, createdAt: '2026-10-22', updatedAt: '2026-10-22', url: '<img src=x onerror="bad()">', eventTypes: ['<script>bad()</script>' as never], enabled: false};
  const delivery: WebhookDelivery = {id: 'delivery', tenantId: 'A', endpointId: 'hook', eventId: 'event', eventType: '<script>bad()</script>' as never, status: 'failed', attempts: 3, lastStatusCode: 500, lastError: 'HTTP failure', createdAt: '2026-10-22', updatedAt: '2026-10-22'};
  for (const html of [webhookEndpointHtml(endpoint, true), webhookDeliveryHtml(delivery, [endpoint])]) {
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  }
  assert.match(webhookEndpointHtml(endpoint, true), /Disabled/); assert.match(webhookEndpointHtml(endpoint, true), /Rotate secret/);
  assert.ok(!webhookEndpointHtml(endpoint, false).includes('<button'));
  assert.match(webhookDeliveryHtml(delivery, [endpoint]), /class="error">failed/); assert.match(webhookDeliveryHtml(delivery, []), /hook/); assert.match(webhookDeliveryHtml(delivery, []), /3 attempts/);
  assert.match(webhookDeliveryHtml({...delivery, status: 'delivered', attempts: 1}, []), /class="badge">delivered/);
});

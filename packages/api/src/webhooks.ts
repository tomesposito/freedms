import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { webhookEventTypes, type OutboxEvent, type Principal, type PublicWebhookEndpoint, type WebhookDelivery, type WebhookEndpoint, type WebhookEventType } from '@freedms/shared';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { invalid, onlyKeys, version } from './validation.js';
export type WebhookSender = (url: string, init: {headers: Record<string, string>; body: string}) => Promise<{status: number}>;
export const fetchWebhookSender: WebhookSender = async (url, init) => {
  const result = await fetch(url, {...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000)});
  await result.body?.cancel();
  return {status: result.status};
};
export const MAX_ATTEMPTS = 3;
export async function dispatchWebhooks(repo: TenantRepository, sender: WebhookSender, now: Date) {
  const summary = {created: 0, delivered: 0, failed: 0};
  const endpoints = (await repo.webhookEndpoints()).filter(endpoint => endpoint.enabled);
  if (!endpoints.length) return summary;
  const existing = new Set((await repo.webhookDeliveries()).map(d => JSON.stringify([d.endpointId, d.eventId])));
  for (const event of await repo.events()) {
    if (!webhookEventTypes.includes(event.type as WebhookEventType)) continue;
    for (const endpoint of endpoints) {
      const pair = JSON.stringify([endpoint.id, event.id]);
      if (!endpoint.eventTypes.includes(event.type as WebhookEventType) || existing.has(pair)) continue;
      const date = now.toISOString();
      const delivery: WebhookDelivery = {id: randomUUID(), tenantId: endpoint.tenantId, endpointId: endpoint.id, eventId: event.id, eventType: event.type as WebhookEventType, status: 'failed', attempts: 0, lastStatusCode: null, lastError: null, createdAt: date, updatedAt: date};
      const {id, type, tenantId, aggregateId, aggregateVersion, occurredAt, actorId} = event;
      const body = JSON.stringify({id, type, tenantId, aggregateId, aggregateVersion, occurredAt, actorId});
      const headers = {'content-type': 'application/json', 'x-freedms-event': type, 'x-freedms-delivery': delivery.id, 'x-freedms-signature': `sha256=${createHmac('sha256', endpoint.secret).update(body).digest('hex')}`};
      // Local build: retries are immediate, bounded, and terminal; no scheduler or delayed worker.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        delivery.attempts = attempt; delivery.lastStatusCode = null; delivery.lastError = null;
        try {
          const result = await sender(endpoint.url, {headers, body});
          delivery.lastStatusCode = result.status;
          if (result.status >= 200 && result.status < 300) { delivery.status = 'delivered'; break; }
          delivery.lastError = 'HTTP failure';
        } catch { delivery.lastError = 'Network or timeout failure'; }
      }
      await repo.saveWebhookDelivery(delivery);
      existing.add(pair); summary.created++; summary[delivery.status]++;
    }
  }
  return summary;
}
function publicEndpoint({secret: _secret, ...record}: WebhookEndpoint): PublicWebhookEndpoint { return record; }
function endpointUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid('A webhook URL is required.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Invalid webhook URL.'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw invalid('Use HTTPS, or HTTP with a local receiver, without URL credentials.');
  return url.href;
}
function subscriptions(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(v => !webhookEventTypes.includes(v))) throw invalid('Select distinct supported webhook event types.');
  return value;
}
export async function webhooks(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, sender: WebhookSender) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const endpoint = /^\/webhooks\/endpoints\/([^/]+)(\/rotate-secret)?$/.exec(path);
  const allowed = path === '/webhooks/endpoints' ? ['GET', 'POST'] : path === '/webhooks/deliveries' ? ['GET'] : path === '/webhooks/dispatch' || endpoint?.[2] ? ['POST'] : endpoint ? ['PUT'] : [];
  if (!allowed.length) throw missing();
  if (!allowed.includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  if (method === 'GET') {
    if (path === '/webhooks/deliveries') return response(200, {data: (await repo.webhookDeliveries()).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))});
    return response(200, {data: {endpoints: (await repo.webhookEndpoints()).map(publicEndpoint), eventTypes: webhookEventTypes}});
  }
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can change webhook settings or dispatch deliveries.');
  const body = parseBody(request.body, 4096);
  if (path === '/webhooks/dispatch') { onlyKeys(body, []); return response(200, {data: await dispatchWebhooks(repo, sender, now)}); }
  const date = now.toISOString();
  let saved: WebhookEndpoint; let expected = 0;
  const reveal = !endpoint || Boolean(endpoint[2]);
  if (!endpoint) {
    onlyKeys(body, ['url', 'eventTypes']);
    saved = {id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date, url: endpointUrl(body.url), eventTypes: subscriptions(body.eventTypes), enabled: true, secret: randomBytes(32).toString('hex')};
  } else {
    const record = await repo.webhookEndpoint(requireId(endpoint[1])); if (!record) throw missing();
    onlyKeys(body, endpoint[2] ? ['version'] : ['version', 'url', 'eventTypes', 'enabled']);
    expected = version(body.version); if (record.version !== expected) throw conflict();
    saved = {...record, version: expected + 1, updatedAt: date};
    if (endpoint[2]) saved.secret = randomBytes(32).toString('hex');
    else {
      if ('url' in body) saved.url = endpointUrl(body.url);
      if ('eventTypes' in body) saved.eventTypes = subscriptions(body.eventTypes);
      if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw invalid('Enabled must be a boolean.'); saved.enabled = body.enabled; }
    }
  }
  const event: OutboxEvent = {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: saved.id, aggregateVersion: saved.version, type: expected ? 'webhook.updated' : 'webhook.created', occurredAt: date, deliveryStatus: 'pending'};
  await repo.saveWebhookEndpoint(saved, expected, event);
  return response(expected ? 200 : 201, {data: {...publicEndpoint(saved), ...(reveal ? {secret: saved.secret} : {})}});
}

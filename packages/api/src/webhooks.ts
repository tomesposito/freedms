import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
// Deny special-use IPv4 ranges, including their IPv4-mapped IPv6 forms.
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) nonPublic.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
// Exclude special-purpose/transition assignments as well as documentation space.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) nonPublic.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  if (family !== 6) return false;
  const normalized = new URL(`https://[${address}]/`).hostname;
  const mapped = /^\[::ffff:([a-f0-9]+):([a-f0-9]+)\]$/.exec(normalized);
  if (mapped) {
    const value = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
    return publicAddress([24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.'));
  }
  return globalV6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

/** Injectable DNS and HTTPS seams keep policy and connection pinning testable offline. */
export function hostedWebhookSender(dependencies: {
  resolve?: (hostname: string) => Promise<{address: string; family: number}[]>;
  request?: typeof httpsRequest;
} = {}): WebhookSender {
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, {all: true}));
  const request = dependencies.request ?? httpsRequest;
  return async (value, init) => {
    const url = new URL(endpointUrl(value, true));
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const controller = new AbortController();
    return new Promise<{status: number}>((done, reject) => {
      const timer = setTimeout(() => { controller.abort(); reject(Error('Webhook timeout')); }, 3000);
      const finish = (error: unknown, status?: number) => {
        clearTimeout(timer);
        if (error) reject(error); else done({status: status!});
      };
      void (async () => {
        const addresses = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await resolve(hostname);
        if (controller.signal.aborted) return;
        if (!addresses.length || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw Error('Invalid webhook destination');
        const pinned = addresses[0];
        // No second DNS lookup: this fresh connection can use only the checked address.
        // URL hostname remains intact for Host, TLS SNI and certificate verification.
        const req = request(url, {
          method: 'POST', headers: init.headers, agent: false, signal: controller.signal,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          }
        }, res => {
          res.destroy();
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) finish(Error('Webhook redirect'));
          else finish(null, status);
        });
        req.on('error', error => finish(error));
        req.end(init.body);
      })().catch(error => finish(error));
    });
  };
}

/** Apply URL policy even to stored endpoints and caller-supplied senders. */
export function guardHostedWebhookSender(sender: WebhookSender): WebhookSender {
  return async (url, init) => sender(endpointUrl(url, true), init);
}
export const MAX_ATTEMPTS = 3;
export const MAX_DELIVERIES_PER_PASS = 25;
const drains = new WeakMap<object, Map<string, {rerun: boolean}>>();
/** In-process only. The durable outbox remains drainable after a process stops. */
export function scheduleWebhookDispatch(repo: TenantRepository, sender: WebhookSender, now: Date): void {
  const {owner, tenantId} = repo.webhookDispatchScope ?? {owner: repo, tenantId: ''};
  let tenants = drains.get(owner);
  if (!tenants) { tenants = new Map(); drains.set(owner, tenants); }
  const active = tenants.get(tenantId);
  if (active) { active.rerun = true; return; }
  const state = {rerun: false};
  tenants.set(tenantId, state);
  // Defer all repository and sender work until after scheduling returns.
  void Promise.resolve().then(async () => {
    try {
      for (;;) {
        state.rerun = false;
        const pass = await dispatchWebhooks(repo, sender, now);
        if (!pass.created && !pass.remaining && !state.rerun) break;
      }
    } catch (error) {
      console.error('Webhook dispatch failed', error instanceof Error ? error.name : 'UnknownError');
    } finally { tenants.delete(tenantId); }
  });
}
function deliveryId(endpointId: string, eventId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify([endpointId, eventId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUID v8: application-defined hash.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function dispatchWebhooks(repo: TenantRepository, sender: WebhookSender, now: Date, options: {maxDeliveries?: number} = {}) {
  const limit = options.maxDeliveries ?? MAX_DELIVERIES_PER_PASS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELIVERIES_PER_PASS) throw new RangeError('Invalid delivery pass limit');
  const summary = {created: 0, delivered: 0, failed: 0, remaining: 0};
  const endpoints = (await repo.webhookEndpoints()).filter(endpoint => endpoint.enabled).sort((a, b) => a.id.localeCompare(b.id));
  if (!endpoints.length) return summary;
  const existing = new Set((await repo.webhookDeliveries()).map(d => JSON.stringify([d.endpointId, d.eventId])));
  for (const event of (await repo.events()).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    if (!webhookEventTypes.includes(event.type as WebhookEventType)) continue;
    for (const endpoint of endpoints) {
      const pair = JSON.stringify([endpoint.id, event.id]);
      if (!endpoint.eventTypes.includes(event.type as WebhookEventType) || existing.has(pair)) continue;
      if (summary.created >= limit) { summary.remaining++; continue; }
      const date = now.toISOString();
      const delivery: WebhookDelivery = {id: deliveryId(endpoint.id, event.id), tenantId: endpoint.tenantId, endpointId: endpoint.id, eventId: event.id, eventType: event.type as WebhookEventType, status: 'failed', attempts: 0, lastStatusCode: null, lastError: null, createdAt: date, updatedAt: date};
      const {id, type, tenantId, aggregateId, aggregateVersion, occurredAt, actorId} = event;
      const body = JSON.stringify({id, type, tenantId, aggregateId, aggregateVersion, occurredAt, actorId});
      const headers = {'content-type': 'application/json', 'x-freedms-event': type, 'x-freedms-delivery': delivery.id, 'x-freedms-signature': `sha256=${createHmac('sha256', endpoint.secret).update(body).digest('hex')}`};
      // Retries are immediate, bounded, and terminal for this pair.
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
function endpointUrl(value: unknown, hosted = false): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid('A webhook URL is required.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('Invalid webhook URL.'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw invalid('Use HTTPS, or HTTP with a local receiver, without URL credentials.');
  if (hosted) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.localhost') || (isIP(hostname) && !publicAddress(hostname))) throw invalid('Use a public HTTPS webhook URL without URL credentials.');
  }
  return url.href;
}
function subscriptions(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length || value.some(v => !webhookEventTypes.includes(v))) throw invalid('Select distinct supported webhook event types.');
  return value;
}
export async function webhooks(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, sender: WebhookSender, hosted = false) {
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
  if (path === '/webhooks/dispatch') {
    onlyKeys(body, []);
    const summary = {created: 0, delivered: 0, failed: 0};
    for (;;) {
      const pass = await dispatchWebhooks(repo, sender, now);
      summary.created += pass.created; summary.delivered += pass.delivered; summary.failed += pass.failed;
      if (!pass.remaining) break;
    }
    return response(200, {data: summary});
  }
  const date = now.toISOString();
  let saved: WebhookEndpoint; let expected = 0;
  const reveal = !endpoint || Boolean(endpoint[2]);
  if (!endpoint) {
    onlyKeys(body, ['url', 'eventTypes']);
    saved = {id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date, url: endpointUrl(body.url, hosted), eventTypes: subscriptions(body.eventTypes), enabled: true, secret: randomBytes(32).toString('hex')};
  } else {
    const record = await repo.webhookEndpoint(requireId(endpoint[1])); if (!record) throw missing();
    onlyKeys(body, endpoint[2] ? ['version'] : ['version', 'url', 'eventTypes', 'enabled']);
    expected = version(body.version); if (record.version !== expected) throw conflict();
    saved = {...record, version: expected + 1, updatedAt: date};
    if (endpoint[2]) saved.secret = randomBytes(32).toString('hex');
    else {
      if ('url' in body) saved.url = endpointUrl(body.url, hosted);
      if ('eventTypes' in body) saved.eventTypes = subscriptions(body.eventTypes);
      if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw invalid('Enabled must be a boolean.'); saved.enabled = body.enabled; }
    }
  }
  const event: OutboxEvent = {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: saved.id, aggregateVersion: saved.version, type: expected ? 'webhook.updated' : 'webhook.created', occurredAt: date, deliveryStatus: 'pending'};
  await repo.saveWebhookEndpoint(saved, expected, event);
  return response(expected ? 200 : 201, {data: {...publicEndpoint(saved), ...(reveal ? {secret: saved.secret} : {})}});
}

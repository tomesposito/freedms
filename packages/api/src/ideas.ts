import { randomUUID } from 'node:crypto';
import { PRODUCT_VERSION, canTransitionIdea, type Idea, type IdeaStatus, type OutboxEvent, type Principal } from '@freedms/shared';
import { canManageAccessRequests, type PilotOperator } from './access-requests.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import type { RepositoryFactory } from './repository.js';
import { invalid, onlyKeys, text, version } from './validation.js';

const sorted = (ideas: Idea[]) => ideas.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
const eventFor = (idea: Idea, actorId: string): OutboxEvent => ({
  id: randomUUID(), tenantId: idea.tenantId, actorId, aggregateId: idea.id, aggregateVersion: idea.version,
  type: idea.version === 1 ? 'idea.submitted' : 'idea.status_changed', occurredAt: idea.updatedAt, deliveryStatus: 'pending'
});

export async function ideas(request: ApiRequest, principal: Principal, repositories: RepositoryFactory, now: Date, operator?: PilotOperator): Promise<ApiResponse> {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  onlyKeys(request.query ?? {}, []);
  if (path.startsWith('/admin/ideas')) {
    if (!canManageAccessRequests(principal, operator)) throw new ApiError(403, 'FORBIDDEN', 'Only the pilot operator can review ideas.');
    if (path === '/admin/ideas') {
      if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      if (!repositories.ideasQueue) throw new ApiError(503, 'UNAVAILABLE', 'Ideas review is unavailable.');
      const queue = sorted(await repositories.ideasQueue());
      const names = new Map(await Promise.all([...new Set(queue.map(i => i.tenantId))].map(async id => [id, (await repositories.forTenant(id).tenant())?.name ?? id] as const)));
      return response(200, {data: queue.map(i => ({...i, tenantName: names.get(i.tenantId)!}))});
    }
    const match = /^\/admin\/ideas\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) throw missing();
    if (method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const repo = repositories.forTenant(requireId(match[1]));
    const existing = await repo.idea(requireId(match[2]));
    if (!existing) throw missing();
    const body = parseBody(request.body, 32 * 1024);
    onlyKeys(body, ['version', 'status', 'declineReason', 'shippedNote']);
    const expected = version(body.version);
    if (existing.version !== expected) throw conflict();
    const status = body.status as IdeaStatus;
    if (!canTransitionIdea(existing.status, status)) throw invalid('Choose Under review, Accepted, Declined, or Shipped.');
    const declineReason = text(body.declineReason ?? '', 'Decline reason', 2000, status !== 'Declined') || null;
    const shippedNote = text(body.shippedNote ?? '', 'Shipped note', 2000, true) || null;
    const record: Idea = {...existing, status, declineReason: status === 'Declined' ? declineReason : null,
      shippedNote: status === 'Shipped' ? shippedNote : null, version: expected + 1, updatedAt: now.toISOString()};
    await repo.saveIdea(record, expected, eventFor(record, principal.userId));
    return response(200, {data: record});
  }
  const repo = repositories.forTenant(principal.tenantId);
  if (path === '/ideas/dealership') {
    if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can view dealership ideas.');
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return response(200, {data: sorted(await repo.ideas())});
  }
  if (path !== '/ideas') throw missing();
  if (method === 'GET') return response(200, {data: sorted((await repo.ideas()).filter(i => i.submitter.id === principal.userId))});
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  // Uses the same WAF per-IP and API Gateway stage throttles as other authenticated mutations.
  const body = parseBody(request.body, 32 * 1024);
  onlyKeys(body, ['title', 'description', 'surface', 'productVersion']);
  const user = (await repo.users()).find(u => u.id === principal.userId);
  const timestamp = now.toISOString();
  const record: Idea = {id: randomUUID(), tenantId: principal.tenantId,
    submitter: {id: principal.userId, name: user?.name ?? principal.userId, email: user?.email ?? null},
    title: text(body.title, 'Title', 160), description: text(body.description, 'Description', 5000),
    surface: text(body.surface ?? '', 'Surface', 200, true), productVersion: text(body.productVersion ?? PRODUCT_VERSION, 'Product version', 40),
    status: 'Received', declineReason: null, shippedNote: null, createdAt: timestamp, updatedAt: timestamp, version: 1};
  await repo.saveIdea(record, 0, eventFor(record, principal.userId));
  return response(201, {data: record});
}

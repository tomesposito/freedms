import { randomUUID } from 'node:crypto';
import { DEAL_SIGNATURE_CONSENT, SERVICE_SIGNATURE_CONSENT, maxDocumentBytes, repairOrderTotals, signatureStatusFor, type Principal, type SignatureRecord } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, text, version } from './validation.js';
import { choice } from './crm-validation.js';
import type { TenantRepository } from './repository.js';
import type { DocumentStore } from './document-store.js';
import { packetInputs, packetHash, repairOrderHash, sha256, documentSignatureStatus } from './signature-targets.js';
const canonicalBase64 = (s: string) => !!s.length && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) && Buffer.from(s,'base64').toString('base64') === s;
export async function signatures(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, store?: DocumentStore) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const dealMatch = /^\/deals\/([^/]+)\/(buyers-order\/signatures|documents\/([^/]+)\/(signatures|replace))$/.exec(path);
  const roMatch = /^\/service\/repair-orders\/([^/]+)\/signatures$/.exec(path);
  if (!dealMatch && !roMatch) throw missing();
  if (method !== 'POST') throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  requireWrite(principal, method); onlyKeys(request.query ?? {}, []);
  const deal = dealMatch ? await repo.crmGet('deal',requireId(dealMatch[1])) : undefined;
  const ro = roMatch ? await repo.crmGet('repair-order',requireId(roMatch[1])) : undefined;
  if ((dealMatch && !deal) || (roMatch && !ro)) throw missing();
  const doc = dealMatch?.[3] ? await repo.crmGet('document',requireId(dealMatch[3])) : undefined;
  if (dealMatch?.[3] && (!doc || doc.dealId !== deal!.id)) throw missing();
  if (doc?.status) throw invalid('Disposed or disposal-pending documents cannot be signed or replaced.');
  if (deal && !doc && !['approved','sold'].includes(deal.status)) throw invalid('A deal jacket is available only for approved or sold deals.');
  const b = parseBody(request.body, dealMatch?.[4] === 'replace' ? 65536 : 136 * 1024), date = now.toISOString();
  const records = await repo.crmList('signature');
  if (doc && dealMatch?.[4] === 'replace') {
    onlyKeys(b,['version','content']); if (version(b.version) !== doc.version) throw conflict();
    if (typeof b.content !== 'string' || b.content.length > Math.ceil(maxDocumentBytes/3)*4 || !canonicalBase64(b.content)) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
    const bytes = Buffer.from(b.content,'base64'); if (bytes.length > maxDocumentBytes) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
    if (!store) throw new ApiError(503,'STORAGE_UNAVAILABLE','Document storage is not configured.');
    const storage = store.forTenant(principal.tenantId), old = await storage.get(doc.id); if (!old) throw missing();
    const record = {...doc, version:doc.version+1, size:bytes.length, updatedAt:date};
    await storage.put(doc.id,bytes);
    try { await repo.crmWrite([{record, expectedVersion:doc.version, event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:doc.id,aggregateVersion:record.version,type:'document.updated',occurredAt:date,deliveryStatus:'pending'}}]); }
    catch (error) { await storage.put(doc.id,old); throw error; }
    return response(200,{data:{...record,signatureStatus:await documentSignatureStatus(record,records,store)}});
  }
  onlyKeys(b,['signerName','method','signatureData']);
  const signerName = text(b.signerName,'Signer name',160), captureMethod = choice(b.method,['drawn','typed'],'signature method');
  let signatureData: string;
  if (captureMethod === 'typed') signatureData = text(b.signatureData,'Typed signature',160);
  else {
    if (typeof b.signatureData !== 'string' || b.signatureData.length > 131072 || !b.signatureData.startsWith('data:image/png;base64,') || !canonicalBase64(b.signatureData.slice(22))) throw invalid('Provide a PNG data URL with canonical base64, at most 131072 characters.');
    signatureData = b.signatureData;
  }
  let targetHash: string;
  if (doc) {
    if (!store) throw new ApiError(503,'STORAGE_UNAVAILABLE','Document storage is not configured.');
    const bytes = await store.forTenant(principal.tenantId).get(doc.id); if (!bytes) throw missing();
    targetHash = sha256(bytes);
  } else targetHash = ro ? repairOrderHash(ro) : packetHash(await packetInputs(repo,deal!));
  const targetType = doc ? 'document' : ro ? 'repair-order' : 'buyers-order';
  const status = doc ? await documentSignatureStatus(doc,records,store) : signatureStatusFor(records,targetType,(ro ?? deal)!.id,targetHash);
  if (status === 'signed') throw conflict();
  const record: SignatureRecord = {id:randomUUID(),kind:'signature',tenantId:principal.tenantId,version:1,createdAt:date,updatedAt:date,targetType,dealId:deal?.id ?? null,documentId:doc?.id ?? null,repairOrderId:ro?.id ?? null,targetLabel:doc?.name ?? (ro ? 'Repair order authorization' : "Buyer's order"),targetVersion:(doc ?? ro ?? deal)!.version,targetHash,signerName,method:captureMethod,signatureData,consentText:ro ? SERVICE_SIGNATURE_CONSENT : DEAL_SIGNATURE_CONSENT,signedAt:date,capturedBy:principal.userId,...(ro ? {estimateCents:repairOrderTotals(ro.lineItems).totalCents} : {})};
  await repo.crmWrite([{record,expectedVersion:0,event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:record.id,aggregateVersion:1,type:'signature.created',occurredAt:date,deliveryStatus:'pending'}}]);
  return response(201,{data:record});
}

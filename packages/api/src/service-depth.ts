import { randomUUID } from 'node:crypto';
import { serviceSkills, repairOrderTotals, type Technician, type LaborRate, type Dispatch, type InspectionItem, type RepairOrder, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice } from './crm-validation.js';
import { invalid, object, onlyKeys, text, money, version } from './validation.js';
import type { TenantRepository } from './repository.js';
export async function serviceCatalog(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const m = /^\/service\/(technicians|labor-rates)(?:\/([^/]+))?$/.exec(request.path.replace(/\/$/, '')); if (!m) return;
  const tech = m[1] === 'technicians', kind = tech ? 'technician' : 'labor-rate', id = m[2] ? requireId(m[2]) : undefined, method = request.method.toUpperCase();
  onlyKeys(request.query ?? {}, []);
  if (!(id ? ['GET','PUT'] : ['GET','POST']).includes(method)) throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  const old = id ? await repo.crmGet(kind,id) : undefined; if (id && !old) throw missing();
  if (method === 'GET') return response(200,{data:old ?? await repo.crmList(kind)});
  requireWrite(principal,method);
  const b = parseBody(request.body); onlyKeys(b,[...(tech ? ['name','skills'] : ['skill','laborRateCents']),...(id ? ['version'] : [])]);
  const expected = old ? version(b.version) : 0; if (old && old.version !== expected) throw conflict();
  const time = now.toISOString(), base = {id:id ?? randomUUID(),tenantId:principal.tenantId,version:expected+1,createdAt:old?.createdAt ?? time,updatedAt:time};
  let record: Technician | LaborRate;
  if (tech) {
    if (!Array.isArray(b.skills) || b.skills.length > serviceSkills.length) throw invalid('Provide a bounded list of technician skills.');
    record = {...base,kind:'technician',name:text(b.name,'Name',120),skills:[...new Set(b.skills.map(s=>choice(s,serviceSkills,'skill')))]};
  } else {
    const skill = choice(b.skill,serviceSkills,'skill');
    // Skill is the natural key: concurrent creates cannot produce ambiguous rates.
    if (old && old.id !== skill) throw invalid('A labor grid entry cannot change skill.');
    record = {...base,id:skill,kind:'labor-rate',skill,laborRateCents:money(b.laborRateCents,'Labor rate')};
  }
  await repo.crmWrite([{record,expectedVersion:expected,event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:record.id,aggregateVersion:record.version,type:`${kind}.${old ? 'updated':'created'}`,occurredAt:time,deliveryStatus:'pending'}}]);
  return response(old ? 200:201,{data:record});
}
export async function dispatch(repo: TenantRepository, principal: Principal, time: string, b: Record<string,unknown>, old?: Dispatch, assignmentRequested = false): Promise<Dispatch> {
  const technicianId = b.technicianId == null || b.technicianId === '' ? null : requireId(b.technicianId);
  const requiredSkill = b.requiredSkill == null || b.requiredSkill === '' ? null : choice(b.requiredSkill,serviceSkills,'required skill');
  if (b.acknowledgeSkillMismatch !== undefined && typeof b.acknowledgeSkillMismatch !== 'boolean') throw invalid('Mismatch acknowledgement must be boolean.');
  const tech = technicianId ? await repo.crmGet('technician',technicianId) : undefined;
  if (technicianId && !tech) throw invalid('Technician must belong to this workspace.');
  let skillMismatchWarning = old?.skillMismatchWarning ?? null;
  if (tech && requiredSkill && !tech.skills.includes(requiredSkill)) {
    const prior = old?.technicianId === technicianId && old.requiredSkill === requiredSkill && skillMismatchWarning?.technicianId === technicianId && skillMismatchWarning.requiredSkill === requiredSkill;
    if ((!prior || assignmentRequested) && b.acknowledgeSkillMismatch !== true) throw invalid(`${tech.name} does not have required skill ${requiredSkill}. Explicitly acknowledge the skill mismatch.`);
    if (b.acknowledgeSkillMismatch === true) skillMismatchWarning = {technicianId:tech.id,requiredSkill,acknowledgedBy:principal.userId,acknowledgedAt:time};
  }
  return {technicianId,requiredSkill,skillMismatchWarning};
}
export async function inspect(repo: TenantRepository, value: unknown, old?: RepairOrder) {
  if (!Array.isArray(value) || value.length > 100) throw invalid('Provide at most 100 inspection items.');
  const ids = new Set<string>(), recommendations = structuredClone(old?.recommendations ?? []);
  const inspection: InspectionItem[] = [];
  for (const v of value) {
    const b = object(v); onlyKeys(b,['id','label','status','skill','laborHoursHundredths','partId']);
    const id = b.id === undefined ? randomUUID() : requireId(b.id); if (ids.has(id)) throw invalid('Inspection item ids must be unique.'); ids.add(id);
    const hours = b.laborHoursHundredths ?? 100;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 100000) throw invalid('Invalid inspection labor hours.');
    const item: InspectionItem = {id,label:text(b.label,'Inspection label',200),status:choice(b.status,['ok','monitor','needs-attention'],'inspection status'),skill:choice(b.skill ?? 'general',serviceSkills,'skill'),laborHoursHundredths:hours,partId:b.partId == null || b.partId === '' ? null:requireId(b.partId)};
    const part = item.partId ? await repo.crmGet('part',item.partId) : undefined; if (item.partId && !part) throw invalid('Part must belong to this workspace.');
    inspection.push(item);
    if (item.status !== 'needs-attention' || recommendations.some(r=>r.inspectionItemId===id)) continue;
    if (recommendations.length >= 100) throw invalid('At most 100 recommendations per repair order.');
    const rate = await repo.crmGet('labor-rate',item.skill);
    if (!rate) throw invalid(`Configure a labor rate for ${item.skill} before recommending work.`);
    const lines = [{id:randomUUID(),kind:'labor' as const,description:item.label,skill:item.skill,laborHoursHundredths:hours,laborRateCents:rate.laborRateCents,quantity:null,unitPriceCents:null},...(part ? [{id:randomUUID(),kind:'parts' as const,description:part.description,partId:part.id,laborHoursHundredths:null,laborRateCents:null,quantity:1,unitPriceCents:part.retailPriceCents}] : [])];
    recommendations.push({id:randomUUID(),inspectionItemId:id,description:item.label,estimatedPriceCents:repairOrderTotals(lines).totalCents,status:'pending',lines,lineIds:[]});
  }
  return {inspection,recommendations};
}

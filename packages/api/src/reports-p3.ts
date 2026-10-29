import { repairOrderTotals, type TechnicianMetrics, type DepartmentReport, type Forecasts, type Projection } from '@freedms/shared';
import { departmentalStatement } from './accounting.js';
import { ApiError, missing } from './errors.js';
import { response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { dateRange } from './reports.js';
type Range = ReturnType<typeof dateRange>;
const within = (date: string, range: Range) => (!range.from || date.slice(0,10) >= range.from) && (!range.to || date.slice(0,10) <= range.to);
const dayMs = 86400000;
const rounded = (n: number) => Math.round(n * 100) / 100;
export async function technicianMetrics(repo: TenantRepository, range: Range): Promise<TechnicianMetrics> {
  const [ros, techs] = await Promise.all([repo.crmList('repair-order'), repo.crmList('technician')]);
  const groups = new Map<string, TechnicianMetrics['rows'][number]>();
  for (const ro of ros.filter(r => within(r.createdAt, range))) {
    const labor = ro.lineItems.filter(l => l.kind === 'labor');
    if (!labor.length) continue;
    const id = ro.technicianId ?? '', tech = techs.find(t => t.id === id);
    const row = groups.get(id) ?? {technicianId:id, technician:id ? tech?.name ?? 'Unknown technician' : 'Unassigned', soldHoursHundredths:0, flaggedHoursHundredths:0, missingFlaggedLines:0, efficiencyPercent:null, roCount:0};
    row.roCount++;
    for (const line of labor) {
      row.soldHoursHundredths += line.laborHoursHundredths ?? 0;
      if (line.flaggedHoursHundredths == null) row.missingFlaggedLines++;
      else row.flaggedHoursHundredths! += line.flaggedHoursHundredths;
    }
    groups.set(id, row);
  }
  const rows = [...groups.values()].sort((a,b) => a.technician.localeCompare(b.technician) || a.technicianId.localeCompare(b.technicianId));
  for (const row of rows) {
    if (row.missingFlaggedLines) row.flaggedHoursHundredths = null;
    row.efficiencyPercent = row.soldHoursHundredths && row.flaggedHoursHundredths !== null ? rounded(row.flaggedHoursHundredths / row.soldHoursHundredths * 100) : null;
  }
  return {...range, rows};
}
export async function departmentReport(repo: TenantRepository, range: Range): Promise<DepartmentReport> {
  const [accounts, entries, ros, sales, parts] = await Promise.all([repo.crmList('gl-account'), repo.crmList('journal-entry'), repo.crmList('repair-order'), repo.crmList('parts-sale'), repo.crmList('part')]);
  const groups = new Map<string, DepartmentReport['locations'][number]>();
  const bucket = (location: string) => {
    let row = groups.get(location);
    if (!row) { row = {location, roCount:0, laborCents:0, servicePartsCents:0, counterSaleCount:0, counterCents:0}; groups.set(location,row); }
    return row;
  };
  for (const ro of ros.filter(r => within(r.createdAt, range) && ['completed','picked-up'].includes(r.status))) {
    const row = bucket('No location'), totals = repairOrderTotals(ro.lineItems);
    row.roCount++; row.laborCents += totals.laborCents; row.servicePartsCents += totals.partsCents;
  }
  for (const sale of sales.filter(s => within(s.createdAt, range))) {
    const row = bucket(parts.find(p => p.id === sale.partId)?.location || 'No location');
    row.counterSaleCount++; row.counterCents += sale.totalCents;
  }
  return {...range, ...departmentalStatement(accounts.sort((a,b) => a.code.localeCompare(b.code)), entries.filter(e => within(e.date, range))), locations:[...groups.values()].sort((a,b) => a.location.localeCompare(b.location))};
}
export async function forecasts(repo: TenantRepository, range: Range, now: Date): Promise<Forecasts> {
  const today = now.toISOString().slice(0,10);
  const to = range.to && range.to < today ? range.to : today;
  const from = range.from ?? new Date(Date.parse(to) - 55 * dayMs).toISOString().slice(0,10);
  if (from > to) {
    const empty = {projection:null, basis:{from,to:range.to ?? from,sampleSize:0}, method:'Historical projections require a basis window on or before today.', insufficientReason:'The selected window has no past dates.'};
    return {inventory:{...empty},service:{...empty},parts:{...empty}};
  }
  const window = {from,to}, days = (Date.parse(to) - Date.parse(from)) / dayMs + 1;
  const {currentStock, soldDates: sold, scheduledStarts, parts, usage} = await repo.forecastRows(window);
  const cutoff = now.toISOString();
  const history = scheduledStarts.filter(start => start <= cutoff);
  const result = <T>(sampleSize: number, method: string, projection: T | null, reason: string): Projection<T> => ({projection,basis:{...window,sampleSize},method,insufficientReason:projection === null ? reason : null});
  const midpoint = new Date(Date.parse(from) + Math.floor(days / 2) * dayMs).toISOString().slice(0,10);
  const earlier = sold.filter(date => date < midpoint).length, recent = sold.length - earlier;
  const earlierDaysSupply = earlier ? rounded(currentStock * Math.floor(days / 2) / earlier) : null;
  const daysSupply = recent ? rounded(currentStock * (days - Math.floor(days / 2)) / recent) : null;
  const inventory = result(sold.length, 'Current unsold stock / daily sales pace in each half of basis window; trend holds current stock constant, not historical inventory.', days >= 14 && sold.length >= 2 && daysSupply !== null ? {currentStock,daysSupply,earlierDaysSupply,changeDays:earlierDaysSupply === null ? null : rounded(daysSupply-earlierDaysSupply)} : null, 'Need at least 14 days, two sold deals, and a sale in the recent half.');
  const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const demand = weekdays.map((day,index) => {
    const firstDay = new Date(from).getUTCDay();
    const offset = (index-firstDay+7)%7, occurrences = offset < days ? Math.floor((days-1-offset)/7)+1 : 0;
    const count = history.filter(date => new Date(date).getUTCDay() === index).length;
    return {day,appointments:count,occurrences,projectedAppointments:occurrences ? rounded(count/occurrences) : 0};
  });
  const service = result(history.length, 'Mean appointments per UTC weekday occurrence (including zero-booking days); excludes no-shows and future appointments.', days >= 14 && history.length >= 2 ? demand : null, 'Need at least 14 days and two past appointments.');
  // Current net stock-applied ROs avoid double counting reopen/recomplete cycles. Creation date is the available history date.
  const unitsByPart = new Map<string, number>();
  for (const {partId, quantity} of usage) unitsByPart.set(partId, (unitsByPart.get(partId) ?? 0) + quantity);
  const reorder = parts.flatMap(p => {
    const unitsUsed = unitsByPart.get(p.id) ?? 0;
    if (!unitsUsed) return [];
    const dailyUse = unitsUsed/days, available = Math.max(0,p.quantityOnHand-(p.quantityReserved ?? 0));
    return [{partId:p.id,partNumber:p.partNumber,location:p.location || 'No location',unitsUsed,dailyUse:rounded(dailyUse),available,daysSupply:rounded(available/dailyUse),reorderNext30Days:Math.max(0,Math.ceil(dailyUse*30)+p.reorderPoint-available)}];
  }).sort((a,b) => a.partNumber.localeCompare(b.partNumber) || a.partId.localeCompare(b.partId));
  const partsForecast = result(usage.length, 'Counter sales + current stock-applied RO usage by creation date; daily depletion × 30 + reorder point − current unreserved stock, rounded up. Excludes vendor returns and incoming POs.', days >= 14 && usage.length >= 2 && reorder.length ? reorder : null, 'Need at least 14 days and two depletion lines for current catalog parts.');
  return {inventory,service,parts:partsForecast};
}
export async function reportsP3(request: ApiRequest, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/,'');
  if (request.method.toUpperCase() !== 'GET') throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  const range = dateRange(request.query);
  if (path === '/reports/technicians') return response(200,{data:await technicianMetrics(repo,range)});
  if (path === '/reports/departments') return response(200,{data:await departmentReport(repo,range)});
  if (path === '/reports/forecasts') return response(200,{data:await forecasts(repo,range,now)});
  throw missing();
}

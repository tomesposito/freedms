import type { TechnicianMetrics, DepartmentReport, Forecasts, Projection } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
const table = (headers: string[], rows: (string | number)[][]) => `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const hours = (n: number | null) => n === null ? '—' : (n/100).toFixed(2);
function projection<T>(title: string, p: Projection<T>, render: (value: T) => string): string {
  return `<section class="card"><h2>${e(title)}</h2><p><strong>Projection — based on ${e(p.basis.from)} to ${e(p.basis.to)}</strong> · ${p.basis.sampleSize} observations</p><p class="muted">${e(p.method)}</p>${p.projection === null ? `<p class="empty">Insufficient history. ${e(p.insufficientReason ?? '')}</p>` : render(p.projection)}</section>`;
}
export function reportsP3Html(tech: TechnicianMetrics, departments: DepartmentReport, forecast: Forecasts): string {
  return technicianHtml(tech) + '\n  ' + departmentReportHtml(departments) + '\n  ' + forecastsHtml(forecast);
}
export function technicianHtml(tech: TechnicianMetrics): string {
  return `<section class="card"><h2>Technician metrics</h2><p>All RO statuses by creation date (UTC); current RO technician assignment. Efficiency = flagged ÷ sold × 100. Missing flagged hours or zero sold hours show —. No assignment is reported as Unassigned.</p>${tech.rows.length ? table(['Technician','Sold hours','Flagged hours','Efficiency','ROs','Lines missing flagged hours'],tech.rows.map(r=>[r.technician,hours(r.soldHoursHundredths),hours(r.flaggedHoursHundredths),r.efficiencyPercent === null ? '—' : `${r.efficiencyPercent}%`,r.roCount,r.missingFlaggedLines])) : '<p class="empty">No RO labor in this range. Add labor and technician assignments to see metrics.</p>'}</section>`;
}
export function departmentReportHtml(departments: DepartmentReport): string {
  return `<section class="card"><h2>Departmental report</h2><p>GL posting dates in the selected range. Uses the same ledger calculation as departmental statements, including reversals.</p>${departments.departments.some(d=>d.rows.length) ? table(['Department','Income','Expenses','Gross profit'],[...departments.departments.map(d=>[d.department,...[d.income,d.expenses,d.grossProfit].map(currency)]),['Total',...[departments.totals.income,departments.totals.expenses,departments.totals.grossProfit].map(currency)]]) : '<p class="empty">No posted income or expenses in this range.</p>'}<h3>Operational location rollup</h3><p>Finalized ROs and counter sales by creation date. Counter sales use current part location; service records have no location. Operational amounts may differ from GL posting totals.</p>${departments.locations.length ? table(['Location','ROs','Labor','Service parts','Counter sales','Counter total'],departments.locations.map(r=>[r.location,r.roCount,currency(r.laborCents),currency(r.servicePartsCents),r.counterSaleCount,currency(r.counterCents)])) : '<p class="empty">No finalized ROs or counter sales in this range.</p>'}</section>`;
}
export function forecastsHtml(forecast: Forecasts): string {
  return `<p>Rule-based projections from this workspace only. Default basis: last 56 days through today; selected dates override it, capped at today. Inventory and parts stock are current snapshots.</p>
  ${projection('Inventory days-supply trend',forecast.inventory,p=>table(['Current stock','Recent pace: days supply','Earlier pace: days supply','Change (days)'],[[p.currentStock,p.daysSupply,p.earlierDaysSupply ?? '—',p.changeDays ?? '—']]))}
  ${projection('Service demand by weekday',forecast.service,rows=>table(['UTC weekday','Appointments','Days observed','Projected per occurrence'],rows.map(r=>[r.day,r.appointments,r.occurrences,r.projectedAppointments])))}
  ${projection('Parts reorder forecast',forecast.parts,rows=>table(['Part','Location','Units depleted','Daily use','Available','Days supply','Order for next 30 days'],rows.map(r=>[r.partNumber,r.location,r.unitsUsed,r.dailyUse,r.available,r.daysSupply,r.reorderNext30Days])))}`;
}

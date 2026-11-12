import type { OverviewReport } from '@freedms/shared';
import { init, use, type EChartsCoreOption } from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { UI } from './desking';
import { currency, escapeHtml as e } from './format';
import { loadErrorHtml, bindLoadRetry } from './load-error';
use([BarChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);
type Source = keyof OverviewReport;
type Window = 'current' | 'trailing 30 days';
interface Tile {metric: string; source: Source; label: string; format?: 'money'; warning?: boolean; window: Window; position: number}
interface Chart {metric: string; source: Source; label: string; subtitle: string; type: 'bar' | 'horizontal-bar'; window: Window; position: number; wide?: boolean; empty: string; actions?: boolean; totalMetric?: string; hideLabels?: boolean; relativeWindowLabels?: boolean; warningCategory?: string}
export const overviewDefinition: {tiles: Tile[]; charts: Chart[]} = {
  tiles: [
    {metric: 'totals.count', source: 'inventory', label: 'Vehicles on lot', window: 'current', position: 0},
    {metric: 'totals.totalCost', source: 'inventory', label: 'Inventory cost', format: 'money', window: 'current', position: 1},
    {metric: 'buckets.3.count', source: 'inventory', label: 'Aged 91+ days', warning: true, window: 'current', position: 2},
    {metric: 'totals.dealsSold', source: 'sales', label: 'Deals sold', window: 'trailing 30 days', position: 3},
    {metric: 'totals.averageGross', source: 'sales', label: 'Average gross', format: 'money', window: 'trailing 30 days', position: 4},
    {metric: 'total', source: 'leads', label: 'Open leads', window: 'current', position: 5},
  ],
  charts: [
    {metric: 'aging', source: 'inventory', label: 'Inventory aging', subtitle: 'Vehicles by days on lot · cost in Reports', type: 'bar', window: 'current', position: 0, warningCategory: '91+', empty: 'No vehicles in inventory yet.', actions: true},
    {metric: 'trend', source: 'sales', label: 'Deals sold', subtitle: 'Per day, trailing 30 days', type: 'bar', window: 'trailing 30 days', position: 1, hideLabels: true, relativeWindowLabels: true, totalMetric: 'totals.dealsSold', empty: 'No deals sold in this range.'},
    {metric: 'pipeline', source: 'leads', label: 'Lead pipeline', subtitle: 'Open leads by stage', type: 'horizontal-bar', window: 'current', position: 2, wide: true, empty: 'No leads yet.'},
  ],
};
const header = '<div class="overview-header"><p class="eyebrow">YOUR STORE</p><h1>Lot overview</h1><p class="muted">Inventory, sales, and leads at a glance — the same numbers as Reports, from the same data.</p></div>';
const ordered = <T extends {position: number}>(items: T[]) => [...items].sort((a, b) => a.position - b.position);
const valueAt = (value: unknown, path: string): number => Number(path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown>)?.[key], value));
const retry = (label: string) => `<div class="overview-error" role="alert">${e(label)} could not be loaded. <button type="button" data-overview-retry>Retry</button></div>`;
const skeleton = '<div class="overview-skeleton" aria-hidden="true"></div>';
type Point = {name: string; value: number; totalCost?: number};
const series: Record<string, (data: OverviewReport) => Point[]> = {
  aging: data => data.inventory.status === 'fulfilled' ? data.inventory.value.buckets.map(b => ({name: b.bucket, value: b.count, totalCost: b.totalCost})) : [],
  trend: data => data.sales.status === 'fulfilled' ? data.sales.value.trend.map(b => ({name: b.date, value: b.count})) : [],
  pipeline: data => data.leads.status === 'fulfilled' ? data.leads.value.byStage.map(b => ({name: b.stage, value: b.count})) : [],
};
export function overviewHtml(data?: OverviewReport): string {
  return `${header}<div class="overview-tiles">${ordered(overviewDefinition.tiles).map(tile => {
    const result = data?.[tile.source];
    const value = result?.status === 'fulfilled' ? valueAt(result.value, tile.metric) : undefined;
    return `<section class="card overview-tile${tile.warning && value && value > 0 ? ' overview-warning' : ''}"><span>${e(tile.label)}</span>${!data ? skeleton : value === undefined ? '<strong aria-label="Unavailable">—</strong>' : `<strong>${e(tile.format === 'money' ? currency(value) : value)}</strong>`}<small>${e(tile.window)}</small></section>`;
  }).join('')}</div><div class="overview-charts">${ordered(overviewDefinition.charts).map((chart, i) => {
    const result = data?.[chart.source], points = data && series[chart.metric](data);
    return `<section class="card overview-panel${chart.wide ? ' overview-wide' : ''}"><h2>${e(chart.label)}</h2><p class="muted">${e(chart.subtitle)}${chart.totalMetric && result?.status === 'fulfilled' ? ` · ${e(valueAt(result.value, chart.totalMetric))} total` : ''}</p>${!data ? skeleton : result?.status === 'rejected' ? retry(chart.label) : !points?.some(p => p.value) ? `<div class="overview-empty"><p>${e(chart.empty)}</p>${chart.actions ? '<a class="button primary" href="#/new">Add vehicle</a> <a class="button" href="#/import">Import CSV</a>' : ''}</div>` : `<div class="overview-chart" data-overview-chart="${i}" role="img" aria-label="${e(`${chart.label}: ${points.map(p => `${p.name}: ${p.value}`).join(', ')}`)}"></div>`}</section>`;
  }).join('')}</div>${data ? '' : '<p class="muted" role="status">Loading reports…</p>'}`;
}
function chartOption(chart: Chart, points: Point[]): EChartsCoreOption {
  const horizontal = chart.type === 'horizontal-bar';
  const category = {type: 'category', data: points.map(p => p.name), axisLine: {show: false}, axisTick: {show: false}, axisLabel: {color: '#879aaa', fontSize: 11, ...(chart.relativeWindowLabels ? {interval: 0, formatter: (_value: string, index: number) => index === 0 ? '30 days ago' : index === points.length - 1 ? 'today' : ''} : {})}, ...(horizontal ? {inverse: true} : {})};
  const count = {type: 'value', minInterval: 1, show: false};
  return {animation: false, aria: {enabled: true}, textStyle: {fontFamily: 'system-ui'},
    grid: {left: horizontal ? 100 : 12, right: 24, top: 25, bottom: 30, containLabel: false},
    tooltip: {trigger: 'item', renderMode: 'richText', formatter: (params: {data: Point}) => `${params.data.name}: ${params.data.value}${params.data.totalCost === undefined ? '' : `\nTotal cost: ${currency(params.data.totalCost)}`}`},
    xAxis: horizontal ? count : category, yAxis: horizontal ? category : count,
    series: [{type: 'bar', data: points.map(p => ({...p, itemStyle: {color: horizontal ? '#ff6a00' : p.name === chart.warningCategory ? '#ee8426' : '#0d3b50', borderRadius: horizontal ? 4 : [4, 4, 0, 0]}})), barMaxWidth: horizontal ? 18 : 70,
      ...(horizontal ? {showBackground: true, backgroundStyle: {color: '#edf2f5', borderRadius: 4}} : {}),
      label: {show: !chart.hideLabels, position: horizontal ? 'right' : 'top', color: '#0b1f2c', fontWeight: 'bold'}}]};
}
let disposeCharts = () => {};
export async function overviewRoute(ui: UI): Promise<void> {
  disposeCharts();
  ui.shell(overviewHtml());
  const today = new Date(), to = today.toISOString().slice(0, 10), from = new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  try {
    const data = await ui.api<OverviewReport>(`/reports/overview?from=${from}&to=${to}`);
    if (!ui.current()) return;
    if (Object.values(data).every(section => section.status === 'rejected')) throw new Error('No reports could be loaded. Please retry.');
    ui.shell(overviewHtml(data));
    document.querySelectorAll('[data-overview-retry]').forEach(button => button.addEventListener('click', ui.refresh));
    const charts = ordered(overviewDefinition.charts);
    const instances = [...document.querySelectorAll<HTMLElement>('[data-overview-chart]')].map(element => {
      const chart = charts[Number(element.dataset.overviewChart)], instance = init(element, undefined, {renderer: 'svg'});
      instance.setOption(chartOption(chart, series[chart.metric](data)));
      return {element, instance};
    });
    const observer = new ResizeObserver(() => instances.forEach(({instance}) => instance.resize()));
    instances.forEach(({element}) => observer.observe(element));
    const removed = new MutationObserver(() => { if (instances.some(({element}) => !element.isConnected)) cleanup(); });
    const cleanup = () => { observer.disconnect(); removed.disconnect(); instances.forEach(({instance}) => instance.dispose()); };
    removed.observe(document.body, {childList: true, subtree: true});
    disposeCharts = cleanup;
  } catch (error) {
    if (ui.current()) { ui.shell(header + loadErrorHtml(error)); bindLoadRetry(ui.refresh); }
  }
}

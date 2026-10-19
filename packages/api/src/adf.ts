import { DOMParser, type Element } from '@xmldom/xmldom';
import type { CustomerInput } from '@freedms/shared';
import { invalid } from './validation.js';
interface Node { name: string; attrs: Record<string, string>; text: string; children: Node[] }
/** Strict XML parsing: reject recovery warnings, DTDs, and oversized/deep trees. */
export function parseAdf(xml: string) {
  if (!xml || Buffer.byteLength(xml) > 65536) throw invalid('ADF XML must be at most 64 KiB.');
  let root: Node;
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD forbidden');
    const document = new DOMParser({onError: () => { throw new Error('Invalid XML'); }}).parseFromString(xml, 'application/xml');
    let count = 0;
    const convert = (element: Element, depth: number): Node => {
      if (++count > 1000 || depth > 20) throw new Error('XML too complex');
      const node: Node = {name: element.tagName, attrs: {}, text: '', children: []};
      for (let i = 0; i < element.attributes.length; i++) { const attr = element.attributes.item(i)!; node.attrs[attr.name] = attr.value; }
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) node.children.push(convert(child as Element, depth + 1));
        else if (child.nodeType === 3 || child.nodeType === 4) node.text += child.nodeValue ?? '';
      }
      return node;
    };
    if (!document.documentElement) throw new Error('Missing root');
    root = convert(document.documentElement, 0);
  } catch { throw invalid('Malformed or unsupported ADF XML.'); }
  const children = (n: Node | undefined, name: string) => n?.children.filter(c => c.name === name) ?? [];
  const one = (n: Node | undefined, name: string) => { const nodes = children(n, name); if (nodes.length > 1) throw invalid(`ADF must contain at most one ${name}.`); return nodes[0]; };
  const value = (n: Node | undefined, name: string) => one(n, name)?.text.trim() ?? '';
  if (root?.name !== 'adf' || (root.attrs.version && root.attrs.version !== '1.0')) throw invalid('Expected ADF 1.0 document.');
  const prospect = one(root, 'prospect'); if (!prospect) throw invalid('ADF requires one prospect.');
  const customer = one(prospect, 'customer'); const contact = one(customer, 'contact');
  if (!contact) throw invalid('ADF customer contact is required.');
  const names = children(contact, 'name');
  const name = names.find(n => n.attrs.part === 'full')?.text.trim() || ['first', 'middle', 'last'].map(part => names.find(n => n.attrs.part === part)?.text.trim()).filter(Boolean).join(' ') || names.map(n => n.text.trim()).filter(Boolean).join(' ');
  const preferred = (tag: string) => { const nodes = children(contact, tag); return (nodes.find(n => n.attrs.preferredcontact === '1') ?? nodes[0])?.text.trim() ?? ''; };
  const address = one(contact, 'address');
  const vehicle = one(prospect, 'vehicle'); const vendor = one(prospect, 'vendor'); const provider = one(prospect, 'provider');
  const sourceDetail = [value(provider, 'name'), value(provider, 'service'), value(vendor, 'vendorname')].filter(Boolean).join(' / ');
  const input: CustomerInput = {name, phone: preferred('phone'), email: preferred('email'), address: [...children(address, 'street').map(n => n.text.trim()), ...['city', 'regioncode', 'postalcode', 'country'].map(k => value(address, k))].filter(Boolean).join(', '),
    notes: value(customer, 'comments'), consent: {status: 'unknown', timestamp: null, source: 'ADF intake'}};
  return {vin: value(vehicle, 'vin').toUpperCase(), stockNumber: value(vehicle, 'stock'), input: {customer: input, source: 'website', sourceDetail,
    vehicleDescription: ['year', 'make', 'model', 'trim', 'vin', 'stock'].map(k => value(vehicle, k)).filter(Boolean).join(' ')}};
}

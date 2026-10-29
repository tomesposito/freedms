import { gzipSync } from 'node:zlib';
import type { ApiResponse } from './handler.js';

const memo = new Map<string, string>();
const maxEntries = 8, maxBytes = 16 * 1024 * 1024;
let memoBytes = 0;

function acceptsGzip(header: string | undefined): boolean {
  let gzip: number | undefined, wildcard = 0;
  for (const entry of (header ?? '').split(',')) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(';');
    const token = coding.trim();
    if (token !== 'gzip' && token !== '*') continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split('=').map(part => part.trim());
      if (name === 'q') quality = value !== undefined && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    }
    // An explicit refusal wins even if a duplicate token accepts gzip.
    if (token === 'gzip') gzip = gzip === 0 ? 0 : quality;
    else wildcard = quality;
  }
  return (gzip ?? wildcard) > 0;
}

export function compressResponse(response: ApiResponse, acceptEncoding: string | undefined): ApiResponse {
  if (!acceptsGzip(acceptEncoding) || response.statusCode === 204 || response.statusCode === 304) return response;
  const headers = Object.entries(response.headers);
  const contentType = headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1].toLowerCase() ?? '';
  if ((!contentType.startsWith('application/json') && !contentType.startsWith('text/csv')) ||
      headers.some(([key]) => key.toLowerCase() === 'content-encoding') || Buffer.byteLength(response.body) < 1024) return response;

  let body = memo.get(response.body);
  if (body !== undefined) {
    memo.delete(response.body);
    memo.set(response.body, body);
  } else {
    body = gzipSync(response.body).toString('base64');
    if (body.length <= maxBytes) {
      while (memo.size >= maxEntries || memoBytes + body.length > maxBytes) {
        const oldest = memo.keys().next().value!;
        memoBytes -= memo.get(oldest)!.length;
        memo.delete(oldest);
      }
      memo.set(response.body, body);
      memoBytes += body.length;
    }
  }
  // A previous identity length cannot describe the compressed wire bytes.
  const compressedHeaders = Object.fromEntries(headers.filter(([key]) => !['content-length', 'vary'].includes(key.toLowerCase())));
  return {...response, headers: {...compressedHeaders, 'content-encoding': 'gzip', vary: 'Accept-Encoding'}, body, isBase64Encoded: true};
}

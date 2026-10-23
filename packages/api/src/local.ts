import { localAuth } from './local-auth.js';
import { localSession } from './local-session.js';
import { analyticsFromEnv } from './analytics.js';
import { bodyLimit } from './quick-entry.js';
import { providerFromEnv } from './ai-provider.js';
import { MemoryDocumentStore } from './document-store.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LocalTokens } from './auth.js';
import { MemoryRepositories } from './memory.js';
import { createHandler, errorResponse } from './handler.js';
import { ApiError } from './errors.js';
import { NhtsaVinDecoder } from './vin.js';
if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === 'production') throw new Error('Local auth must never run in production');
const repositories = new MemoryRepositories();
const tokens = new LocalTokens(randomBytes(48).toString('hex'));
const handle = createHandler(repositories, new NhtsaVinDecoder(), () => new Date(), new MemoryDocumentStore(), providerFromEnv(), analyticsFromEnv());
const server = createServer(async (req, res) => {
  let result;
  try {
    // Loopback only, host/origin allowlist to prevent websites/DNS rebinding from minting local tokens.
    if (!['127.0.0.1:3001', 'localhost:3001'].includes(req.headers.host ?? '') ||
        (req.headers.origin && !['http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin))) throw new ApiError(403, 'FORBIDDEN', 'Local origin not allowed.');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:3001');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > bodyLimit(req.method ?? 'GET', url.pathname)) throw new ApiError(413, 'TOO_LARGE', 'Body exceeds the limit for this endpoint.'); chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString('utf8');
    const isIntake = req.method === 'POST' && url.pathname.replace(/\/$/, '') === '/intake/adf';
    if (isIntake && !['application/xml', 'text/xml'].includes((req.headers['content-type'] ?? '').split(';')[0])) throw new ApiError(415, 'CONTENT_TYPE', 'Use application/xml.');
    if (!isIntake && ['POST', 'PUT', 'DELETE'].includes(req.method ?? '') && !req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'CONTENT_TYPE', 'Use application/json.');
    if (req.method === 'POST' && url.pathname === '/local/session') {
      result = await localSession(body, repositories, tokens);
    } else {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      result = await handle({method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body, ...localAuth(url.pathname, isIntake, token, tokens)});
    }
  } catch (error) { result = errorResponse(error); }
  res.writeHead(result.statusCode, result.headers); res.end(result.body);
});
server.listen(3001, '127.0.0.1', () => console.log('freeDMS local API: http://127.0.0.1:3001 — empty, ephemeral storage; tokens expire after one hour'));

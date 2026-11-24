// The pilot API has two Lambda execution slots. Share that capacity across
// reports, assistant balance refreshes, and downloads in this browser tab;
// bounding an individual page's requests cannot account for shell traffic.
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;
const waitingRequests: Array<() => void> = [];
async function withRequestSlot(request: () => Promise<Response>): Promise<Response> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) await new Promise<void>(resolve => waitingRequests.push(resolve));
  else activeRequests++;
  try { return await request(); }
  finally {
    const next = waitingRequests.shift();
    if (next) next(); // Transfer this slot directly to the oldest queued request.
    else activeRequests--;
  }
}

/** Retry transient responses within the shared request budget; callers own bodies and authentication. */
export async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, options: {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
} = {}): Promise<Response> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    const response = await withRequestSlot(() => request(input, init));
    if (![429, 503].includes(response.status) || attempt === 2) return response;
    const header = response.headers.get('Retry-After');
    const seconds = header?.trim() ? Number(header) : NaN;
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, 5000)
      : 250 * 3 ** attempt + random() * 100;
    await sleep(delay);
  }
}

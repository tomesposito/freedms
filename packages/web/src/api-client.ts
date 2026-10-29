/** Retry only transient HTTP responses; callers retain body and authentication handling. */
export async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, options: {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
} = {}): Promise<Response> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    const response = await request(input, init);
    if (![429, 503].includes(response.status) || attempt === 2) return response;
    const header = response.headers.get('Retry-After');
    const seconds = header?.trim() ? Number(header) : NaN;
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, 5000)
      : 250 * 3 ** attempt + random() * 100;
    await sleep(delay);
  }
}

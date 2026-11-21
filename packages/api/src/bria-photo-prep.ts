import { setTimeout as delay } from 'node:timers/promises';
import { decode, encode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { PHOTO_PREP_IMAGE_BYTES } from '@freedms/shared';
import type { PhotoPrepImageEditor } from './assistant-provider.js';

const origin = 'https://engine.prod.bria-api.com';
const maxResultBytes = 8 * 1024 * 1024;
const failed = () => new Error('Background replacement could not be completed.');

export class BriaPhotoPrepEditor implements PhotoPrepImageEditor {
  readonly configured = true;
  readonly source = 'bria';
  constructor(private readonly apiKey: string, private readonly fetcher = fetch) {}

  async replaceBackground(jpeg: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    const headers = {api_token: this.apiKey, 'content-type': 'application/json'};
    const submit = await this.fetcher(`${origin}/v2/image/edit/replace_background`, {
      method: 'POST', headers, signal, redirect: 'error',
      body: JSON.stringify({
        image: Buffer.from(jpeg).toString('base64'), mode: 'fibo2', original_quality: true, refine_prompt: false, sync: false,
        prompt: 'Replace only the area behind the vehicle with a simple neutral gray studio background and floor. Leave the original vehicle exactly as it appears, including its body, wheels, windows, trim, reflections and visible damage.',
      }),
    });
    if (submit.status !== 202) throw failed();
    const {request_id: id} = await submit.json();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw failed();
    // Derive the documented status path so the API token stays on Bria's API origin.
    while (true) {
      await delay(1000, undefined, {signal});
      const poll = await this.fetcher(`${origin}/v2/status/${id}`, {headers, signal, redirect: 'error'});
      if (!poll.ok) throw failed();
      const job = await poll.json();
      if (job.status === 'IN_PROGRESS') continue;
      if (job.status !== 'COMPLETED' || typeof job.result?.image_url !== 'string') throw failed();
      return this.preview(job.result.image_url, signal);
    }
  }

  private async preview(value: string, signal: AbortSignal) {
    const url = new URL(value);
    // The result may be on Bria's CDN or in a Bria S3 bucket. Never follow redirects
    // or forward the API token to the image host.
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !/(^|\.)(bria-ai\.com|bria-api\.com|bria\.ai)$|^bria-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) throw failed();
    const response = await this.fetcher(url, {signal, redirect: 'error'});
    if (!response.ok || !response.body) throw failed();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const {done, value: chunk} = await reader.read();
      if (done) break;
      length += chunk.length;
      if (length > maxResultBytes) { await reader.cancel(); throw failed(); }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks, length);
    const png = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (png && (data.readUInt32BE(16) > 1200 || data.readUInt32BE(20) > 1200)) throw failed();
    const image = png ? PNG.sync.read(data) : decode(data, {maxResolutionInMP: 1.5, maxMemoryUsageInMB: 32});
    for (const quality of [85, 70, 55, 40, 25, 10]) {
      signal.throwIfAborted();
      const result = encode(image, quality).data;
      if (result.length <= PHOTO_PREP_IMAGE_BYTES) return result;
    }
    throw failed();
  }
}

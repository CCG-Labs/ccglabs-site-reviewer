import type { FetchResult, RateLimitedFetch } from "../types.js";

export interface FetcherOptions {
  requestHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxConcurrent?: number;
}

export class SiteUnreachableError extends Error {}

export class BodySizeCapError extends Error {}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodySizeCapError(
        `Response body exceeded ${String(maxBytes)} bytes: ${response.url}`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createFetcher(options: FetcherOptions = {}): RateLimitedFetch {
  const {
    requestHeaders = {},
    timeoutMs = 15_000,
    maxBodyBytes = 5 * 1024 * 1024,
    maxConcurrent = 5,
  } = options;

  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      queue.push(() => {
        active += 1;
        resolvePromise();
      });
    });
  };
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };

  const attempt = async (url: string, method: string): Promise<FetchResult> => {
    const started = Date.now();
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBodyCapped(response, maxBodyBytes);
    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      redirected: response.redirected,
      durationMs: Date.now() - started,
    };
  };

  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    await acquire();
    try {
      try {
        return await attempt(url, method);
      } catch (error) {
        // Size-cap violations are deliberate rejections, not transient network errors — never retry them.
        if (error instanceof BodySizeCapError) throw error;
        return await attempt(url, method);
      }
    } finally {
      release();
    }
  };
}

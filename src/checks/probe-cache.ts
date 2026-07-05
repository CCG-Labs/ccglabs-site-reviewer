import type { RateLimitedFetch } from "../types.js";

export interface ProbeResult {
  reachable: boolean;
  /** 0 when unreachable */
  status: number;
  headers: Record<string, string>;
  /** the GET body when a GET was performed; "" otherwise */
  body: string;
  /** set only when !reachable */
  error: string | undefined;
}

const UNREACHABLE = (error: string): ProbeResult => ({
  reachable: false,
  status: 0,
  headers: {},
  body: "",
  error,
});

/**
 * A per-URL memoized prober shared across checks. HEAD first; if
 * shouldFallBackToGet(headStatus) is true, a GET is issued and its
 * status/headers/body returned. One in-flight promise per URL.
 */
export function createProbeCache(
  fetchFn: RateLimitedFetch,
  shouldFallBackToGet: (headStatus: number) => boolean = (status) => status >= 400,
): (url: string) => Promise<ProbeResult> {
  const cache = new Map<string, Promise<ProbeResult>>();
  return (url) => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const result = (async (): Promise<ProbeResult> => {
      try {
        const head = await fetchFn(url, { method: "HEAD" });
        if (shouldFallBackToGet(head.status)) {
          const get = await fetchFn(url);
          return {
            reachable: true,
            status: get.status,
            headers: get.headers,
            body: get.body,
            error: undefined,
          };
        }
        return {
          reachable: true,
          status: head.status,
          headers: head.headers,
          body: "",
          error: undefined,
        };
      } catch (error) {
        return UNREACHABLE(error instanceof Error ? error.message : String(error));
      }
    })();
    cache.set(url, result);
    return result;
  };
}

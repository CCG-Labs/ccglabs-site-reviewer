import type {
  AxeRun,
  BrowserPage,
  BrowserProvider,
  FailedRequest,
  LighthouseRun,
} from "../../src/browser/types.js";

export interface FakePageScript {
  status?: number;
  errors?: string[];
  failedRequests?: FailedRequest[];
  requests?: Array<{ url: string; method: string }>;
  content?: string;
  axe?: AxeRun;
  /** scripted lighthouse result(s); an array is consumed in order (last entry repeats) */
  lighthouse?: LighthouseRun | LighthouseRun[];
  /** when set, goto() rejects with an Error carrying this message */
  throwOnGoto?: string;
  /** when set, runAxe() rejects with an Error carrying this message */
  throwOnAxe?: string;
  /** when set, runLighthouse rejects with this message */
  throwOnLighthouse?: string;
}

const PERFECT_LIGHTHOUSE: LighthouseRun = {
  available: true,
  categories: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 },
  metrics: { lcpMs: 1000, cls: 0, tbtMs: 0 },
};

/** An in-memory BrowserProvider that replays scripted per-URL events. No Chromium. */
export function fakeBrowser(scripted: Record<string, FakePageScript>): BrowserProvider {
  const lighthouseCalls = new Map<string, number>();
  return {
    runLighthouse(url: string): Promise<LighthouseRun> {
      const script = scripted[url];
      if (script?.throwOnLighthouse !== undefined) {
        return Promise.reject(new Error(script.throwOnLighthouse));
      }
      const scriptedRun = script?.lighthouse;
      if (scriptedRun === undefined) return Promise.resolve(PERFECT_LIGHTHOUSE);
      if (!Array.isArray(scriptedRun)) return Promise.resolve(scriptedRun);
      const used = lighthouseCalls.get(url) ?? 0;
      lighthouseCalls.set(url, used + 1);
      return Promise.resolve(
        scriptedRun[Math.min(used, scriptedRun.length - 1)] ?? PERFECT_LIGHTHOUSE,
      );
    },
    newPage(): Promise<BrowserPage> {
      const errorHandlers: Array<(message: string) => void> = [];
      const failedHandlers: Array<(request: FailedRequest) => void> = [];
      const requestHandlers: Array<(url: string, method: string) => void> = [];
      let script: FakePageScript = {};
      const page: BrowserPage = {
        onError(handler) {
          errorHandlers.push(handler);
        },
        onRequestFailed(handler) {
          failedHandlers.push(handler);
        },
        onRequest(handler) {
          requestHandlers.push(handler);
        },
        goto(url) {
          script = scripted[url] ?? {};
          if (script.throwOnGoto !== undefined)
            return Promise.reject(new Error(script.throwOnGoto));
          for (const request of script.requests ?? [])
            for (const handler of requestHandlers) handler(request.url, request.method);
          for (const message of script.errors ?? [])
            for (const handler of errorHandlers) handler(message);
          for (const failure of script.failedRequests ?? [])
            for (const handler of failedHandlers) handler(failure);
          return Promise.resolve(script.status ?? 200);
        },
        content() {
          return Promise.resolve(script.content ?? "<html></html>");
        },
        runAxe() {
          if (script.throwOnAxe !== undefined) return Promise.reject(new Error(script.throwOnAxe));
          return Promise.resolve(script.axe ?? { available: true, violations: [] });
        },
        close() {
          return Promise.resolve();
        },
      };
      return Promise.resolve(page);
    },
  };
}

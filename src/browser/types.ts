/** A failed sub-resource request observed during navigation. */
export interface FailedRequest {
  url: string;
  failure: string;
}

/** A distilled axe-core violation — no axe types leak past the driver seam. */
export interface AxeViolation {
  /** axe rule id, e.g. "color-contrast" */
  id: string;
  impact: "critical" | "serious" | "moderate" | "minor" | null;
  /** human-readable rule description */
  help: string;
  /** number of DOM elements failing this rule on the page */
  nodeCount: number;
}

export interface AxeRun {
  /** false when @axe-core/playwright could not be imported */
  available: boolean;
  violations: AxeViolation[];
}

/** A distilled Lighthouse result — no lighthouse types leak past the driver seam. */
export interface LighthouseRun {
  /** false when the lighthouse peer dep could not be imported */
  available: boolean;
  /** category scores 0–100; null when Lighthouse could not score a category */
  categories: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  /** lab metrics; TBT stands in for INP (INP needs field data) */
  metrics: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
  };
}

/**
 * A single isolated browser page. Handlers must be registered BEFORE goto().
 * Backed by a real Playwright page in production, a fake in tests — no check
 * imports playwright directly.
 */
export interface BrowserPage {
  /** register a handler for uncaught page exceptions (pageerror); console.error is intentionally not delivered */
  onError(handler: (message: string) => void): void;
  /** register a handler for failed sub-resource requests */
  onRequestFailed(handler: (request: FailedRequest) => void): void;
  /** register a handler for every outgoing request (URL + method) */
  onRequest(handler: (url: string, method: string) => void): void;
  /** navigate; resolves with the main response status, or rejects on nav failure */
  goto(url: string): Promise<number>;
  /** the rendered HTML after scripts run */
  content(): Promise<string>;
  /** run an axe-core scan against the current page; available:false when the axe peer dep is absent */
  runAxe(options?: { standard?: string[]; ignore?: string[] }): Promise<AxeRun>;
  /** close this page and its context */
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** a fresh isolated page; the engine tracks and closes it at teardown */
  newPage(): Promise<BrowserPage>;
  /** run Lighthouse against a URL over the shared browser's CDP port; available:false when the lighthouse peer dep is absent */
  runLighthouse(url: string): Promise<LighthouseRun>;
}

/** Thrown by the provider when the browser is present-but-unlaunchable (e.g. Chromium not installed). */
export class BrowserLaunchError extends Error {}

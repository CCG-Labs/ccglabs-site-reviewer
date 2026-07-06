/** A failed sub-resource request observed during navigation. */
export interface FailedRequest {
  url: string;
  failure: string;
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
  /** close this page and its context */
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** a fresh isolated page; the engine tracks and closes it at teardown */
  newPage(): Promise<BrowserPage>;
}

/** Thrown by the provider when the browser is present-but-unlaunchable (e.g. Chromium not installed). */
export class BrowserLaunchError extends Error {}

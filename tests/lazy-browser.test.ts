import { describe, expect, it, vi } from "vitest";
import { createLazyBrowser, probeBrowserCapability } from "../src/browser/lazy-browser.js";
import { fakeBrowser } from "./helpers/fake-browser.js";

describe("probeBrowserCapability", () => {
  it("is true when the importer resolves", async () => {
    expect(await probeBrowserCapability(() => Promise.resolve({}))).toBe(true);
  });
  it("is false when the importer rejects (dep not installed)", async () => {
    expect(
      await probeBrowserCapability(() => Promise.reject(new Error("Cannot find module"))),
    ).toBe(false);
  });
});

describe("createLazyBrowser", () => {
  it("does not build the driver until the first newPage", async () => {
    const factory = vi.fn(() =>
      Promise.resolve({ provider: fakeBrowser({}), teardown: () => Promise.resolve() }),
    );
    const lazy = createLazyBrowser(factory);
    expect(factory).not.toHaveBeenCalled();
    await lazy.provider.newPage();
    expect(factory).toHaveBeenCalledTimes(1);
    await lazy.provider.newPage();
    expect(factory).toHaveBeenCalledTimes(1); // memoized
  });

  it("teardown is a no-op when the browser never launched", async () => {
    const teardown = vi.fn(() => Promise.resolve());
    const factory = vi.fn(() => Promise.resolve({ provider: fakeBrowser({}), teardown }));
    const lazy = createLazyBrowser(factory);
    await lazy.teardown();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("teardown closes the driver once it has launched", async () => {
    const teardown = vi.fn(() => Promise.resolve());
    const lazy = createLazyBrowser(() => Promise.resolve({ provider: fakeBrowser({}), teardown }));
    await lazy.provider.newPage();
    await lazy.teardown();
    expect(teardown).toHaveBeenCalledTimes(1);
    await lazy.teardown(); // idempotent
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

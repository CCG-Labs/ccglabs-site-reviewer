import { describe, expect, it } from "vitest";
import { BrowserLaunchError } from "../src/browser/types.js";

describe("browser types", () => {
  it("exports a BrowserLaunchError distinct from Error", () => {
    const error = new BrowserLaunchError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error.message).toBe("boom");
  });
});

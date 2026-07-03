import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public API", () => {
  it("exports the documented surface", () => {
    expect(typeof api.runReview).toBe("function");
    expect(typeof api.defineConfig).toBe("function");
    expect(Array.isArray(api.builtinChecks)).toBe(true);
    expect(api.REPORT_VERSION).toBe(1);
    expect(api.reviewReportSchema).toBeDefined();
    expect(api.SiteUnreachableError).toBeDefined();
    expect(api.BodySizeCapError).toBeDefined();
  });
});

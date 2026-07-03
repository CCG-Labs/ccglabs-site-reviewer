import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/define.js";
import { loadConfigFile } from "../src/config/load.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "site-review-"));

describe("loadConfigFile", () => {
  it("returns undefined when no config file exists", async () => {
    expect(await loadConfigFile(freshDir())).toBeUndefined();
  });

  it("loads a JSON config", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.json"), JSON.stringify({ failThreshold: 75 }));
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 75 });
  });

  it("loads a TypeScript config with a default export", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.ts"), "export default { failThreshold: 65 };\n");
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 65 });
  });

  it("loads a JS config with a default export", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.js"), "export default { failThreshold: 55 };\n");
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 55 });
  });

  it("loads an MJS config with a default export", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "site-review.config.mjs"), "export default { failThreshold: 45 };\n");
    expect(await loadConfigFile(dir)).toEqual({ failThreshold: 45 });
  });

  it("loads a config with an explicit path", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "custom.config.ts"), "export default { failThreshold: 70 };\n");
    expect(await loadConfigFile(dir, "custom.config.ts")).toEqual({ failThreshold: 70 });
  });

  it("throws when an explicit path does not exist", async () => {
    await expect(loadConfigFile(freshDir(), "missing.config.ts")).rejects.toThrow(
      "Config file not found",
    );
  });
});

describe("defineConfig", () => {
  it("returns its argument (identity helper for typed configs)", () => {
    const config = { failThreshold: 90 };
    expect(defineConfig(config)).toBe(config);
  });
});

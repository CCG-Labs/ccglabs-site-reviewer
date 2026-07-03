import { describe, expect, it } from "vitest";
import { TOOL_NAME } from "../src/index.js";

describe("package entry", () => {
  it("exports the tool name", () => {
    expect(TOOL_NAME).toBe("@ccglabs/site-reviewer");
  });
});

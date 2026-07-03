import { describe, expect, it } from "vitest";
import {
  categoryScore,
  computeGrade,
  overallScore,
  statusFromFindings,
} from "../src/engine/score.js";

const finding = (severity: "error" | "warning" | "info") => ({
  severity,
  message: "m",
  recommendation: "r",
});

describe("statusFromFindings", () => {
  it("is pass with no findings", () => {
    expect(statusFromFindings([])).toBe("pass");
  });
  it("is warn with only warnings/info", () => {
    expect(statusFromFindings([finding("warning"), finding("info")])).toBe("warn");
  });
  it("is fail with any error", () => {
    expect(statusFromFindings([finding("warning"), finding("error")])).toBe("fail");
  });
});

describe("categoryScore", () => {
  it("weight-averages check scores", () => {
    expect(
      categoryScore([
        { score: 100, weight: 1, status: "pass" },
        { score: 40, weight: 3, status: "fail" },
      ]),
    ).toBe(55);
  });
  it("excludes errored checks from the average", () => {
    expect(
      categoryScore([
        { score: 0, weight: 1, status: "error" },
        { score: 80, weight: 1, status: "pass" },
      ]),
    ).toBe(80);
  });
  it("returns 100 when nothing was scorable", () => {
    expect(categoryScore([])).toBe(100);
  });
});

describe("overallScore", () => {
  it("averages category scores", () => {
    expect(overallScore([100, 50])).toBe(75);
  });
  it("returns 100 for no categories", () => {
    expect(overallScore([])).toBe(100);
  });
});

describe("computeGrade", () => {
  it("passes at or above threshold with no blocking failures", () => {
    expect(computeGrade({ overall: 80, failThreshold: 80, anyBlockingFailed: false })).toBe("pass");
  });
  it("fails below threshold", () => {
    expect(computeGrade({ overall: 79, failThreshold: 80, anyBlockingFailed: false })).toBe("fail");
  });
  it("fails on a blocking failure regardless of score", () => {
    expect(computeGrade({ overall: 100, failThreshold: 80, anyBlockingFailed: true })).toBe("fail");
  });
});

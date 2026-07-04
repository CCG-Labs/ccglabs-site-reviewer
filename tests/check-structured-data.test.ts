import { describe, expect, it } from "vitest";
import { structuredDataCheck } from "../src/checks/seo/structured-data.js";
import { builtinChecks } from "../src/engine/registry.js";
import type { CheckContext, Environment } from "../src/types.js";
import { fixturePageStore } from "./helpers/page-store.js";

const script = (content: string) => `<script type="application/ld+json">${content}</script>`;

const page = (scripts: string[]) =>
  `<html lang="en"><head><title>t</title>${scripts.join("")}</head><body></body></html>`;

const contextFor = (
  pages: Parameters<typeof fixturePageStore>[0],
  environment: Environment = "production",
): CheckContext => ({
  baseUrl: "https://example.com",
  environment,
  config: {
    environment,
    maxPages: 200,
    failThreshold: 80,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  },
  pages: fixturePageStore(pages),
  fetch: () => Promise.reject(new Error("no fetch in this test")),
  logger: { debug: () => undefined },
});

describe("seo.structured-data", () => {
  it("is registered as a built-in", () => {
    expect(builtinChecks.map((check) => check.id)).toContain("seo.structured-data");
  });

  it("passes a site with valid Organization + WebSite JSON-LD", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: page([
            script(
              JSON.stringify({
                "@type": "Organization",
                name: "CCG Labs",
                url: "https://example.com",
              }),
            ),
            script(
              JSON.stringify({ "@type": "WebSite", name: "CCG Labs", url: "https://example.com" }),
            ),
          ]),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("flags a malformed JSON-LD block as an error naming the block and page, and scores the dirty page", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        { url: "https://example.com/bad", body: page([script("{not json")]) },
        { url: "https://example.com/clean", body: page([]) },
      ]),
    );
    const errors = outcome.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.url).toBe("https://example.com/bad");
    expect(errors[0]?.message).toContain("block 1");
    expect(outcome.score).toBe(50); // 1 of 2 pages clean
  });

  it("flags missing required properties in one warning listing both names, without affecting score", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: page([script(JSON.stringify({ "@type": "Article", headline: "Big News" }))]),
        },
      ]),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("datePublished");
    expect(warnings[0]?.message).toContain("author");
    expect(outcome.score).toBe(100);
  });

  it("warns when an entity has no @type", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        { url: "https://example.com/", body: page([script(JSON.stringify({ name: "X" }))]) },
      ]),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    expect(warnings.some((finding) => finding.message.includes("no @type"))).toBe(true);
  });

  it("emits an info finding for a non-schema.org @context", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: page([
            script(
              JSON.stringify({
                "@context": "https://example.org/vocab",
                "@type": "Organization",
                name: "N",
                url: "https://example.com",
              }),
            ),
          ]),
        },
      ]),
    );
    const infos = outcome.findings.filter((finding) => finding.severity === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain("https://example.org/vocab");
  });

  it("checks each type in an @type array and does not flag types absent from the required-props table", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: page([
            script(
              JSON.stringify({
                "@type": ["Organization", "Brand"],
                name: "N",
                url: "https://example.com",
              }),
            ),
          ]),
        },
      ]),
    );
    expect(outcome).toEqual({ score: 100, findings: [] });
  });

  it("warns on conflicting singleton entities (two Organizations with different names) naming both", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        {
          url: "https://example.com/",
          body: page([
            script(
              JSON.stringify({
                "@type": "Organization",
                name: "Acme",
                url: "https://acme.example",
              }),
            ),
            script(
              JSON.stringify({
                "@type": "Organization",
                name: "Widgets Co",
                url: "https://widgets.example",
              }),
            ),
          ]),
        },
      ]),
    );
    const warnings = outcome.findings.filter((finding) => finding.severity === "warning");
    const conflict = warnings.find((finding) => finding.message.includes("Conflicting"));
    expect(conflict?.message).toContain("Acme");
    expect(conflict?.message).toContain("Widgets Co");
  });

  it("emits a single site-level warning attributed to the base URL when no JSON-LD exists anywhere", async () => {
    const outcome = await structuredDataCheck.run(
      contextFor([
        { url: "https://example.com/", body: page([]) },
        { url: "https://example.com/about", body: page([]) },
      ]),
    );
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.severity).toBe("warning");
    expect(outcome.findings[0]?.url).toBe("https://example.com");
    expect(outcome.score).toBe(100);
  });

  it("returns 100 with no findings for an empty page store", async () => {
    const outcome = await structuredDataCheck.run(contextFor([]));
    expect(outcome).toEqual({ score: 100, findings: [] });
  });
});

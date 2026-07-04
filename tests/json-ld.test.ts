import { describe, expect, it } from "vitest";
import { extractJsonLd } from "../src/checks/seo/json-ld.js";

const script = (content: string) => `<script type="application/ld+json">${content}</script>`;

describe("extractJsonLd", () => {
  it("parses a single object block into one entity", () => {
    const result = extractJsonLd(
      `<html><head>${script('{"@type":"Organization","name":"CCG"}')}</head></html>`,
    );
    expect(result.blockCount).toBe(1);
    expect(result.parseErrors).toEqual([]);
    expect(result.entities).toEqual([
      { value: { "@type": "Organization", name: "CCG" }, blockIndex: 0 },
    ]);
  });

  it("flattens top-level arrays and @graph containers", () => {
    const result = extractJsonLd(
      `<html><body>
        ${script('[{"@type":"Person","name":"A"},{"@type":"Person","name":"B"}]')}
        ${script('{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"S","url":"https://s.example"},{"@type":"Organization","name":"O","url":"https://o.example"}]}')}
      </body></html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.entities.map((entity) => entity.value["@type"])).toEqual([
      "Person",
      "Person",
      "WebSite",
      "Organization",
    ]);
    expect(result.entities.map((entity) => entity.blockIndex)).toEqual([0, 0, 1, 1]);
  });

  it("records parse errors per block without aborting the others", () => {
    const result = extractJsonLd(
      `<html>${script("{not json")}${script('{"@type":"Product","name":"P"}')}</html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]?.blockIndex).toBe(0);
    expect(result.parseErrors[0]?.message).not.toBe("");
    expect(result.entities).toHaveLength(1);
  });

  it("ignores non-JSON-LD scripts and non-object JSON values", () => {
    const result = extractJsonLd(
      `<html><script>var x = 1;</script>${script('"just a string"')}${script("42")}</html>`,
    );
    expect(result.blockCount).toBe(2);
    expect(result.parseErrors).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it("keeps a @graph wrapper as an entity when it has its own @type", () => {
    const result = extractJsonLd(
      `<html>${script('{"@type":"WebPage","name":"W","@graph":[{"@type":"Person","name":"A"}]}')}</html>`,
    );
    expect(result.entities.map((entity) => entity.value["@type"])).toEqual(["WebPage", "Person"]);
  });

  it("returns empty extraction for HTML without JSON-LD", () => {
    expect(extractJsonLd("<html><body><p>hi</p></body></html>")).toEqual({
      blockCount: 0,
      entities: [],
      parseErrors: [],
    });
  });

  it("honors a case-insensitive script type attribute", () => {
    const result = extractJsonLd(
      `<html>${script('{"@type":"Thing"}').replace('type="application/ld+json"', 'type="APPLICATION/LD+JSON"')}</html>`,
    );
    expect(result.blockCount).toBe(1);
    expect(result.entities).toEqual([{ value: { "@type": "Thing" }, blockIndex: 0 }]);
  });

  it("yields one entity with no @type for an empty object block", () => {
    const result = extractJsonLd(`<html>${script("{}")}</html>`);
    expect(result.blockCount).toBe(1);
    expect(result.parseErrors).toEqual([]);
    expect(result.entities).toEqual([{ value: {}, blockIndex: 0 }]);
  });
});

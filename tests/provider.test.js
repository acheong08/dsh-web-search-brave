import { describe, it, expect } from "vitest";
import { mapBraveResponse, pickPublishedAt } from "../lib/index.js";

describe("mapBraveResponse", () => {
  it("maps web.results with page_age as publishedAt", () => {
    const result = mapBraveResponse({
      web: {
        results: [
          { title: "Brave One", url: "https://x.com", description: "desc", page_age: "2026-08-06T00:05:04" }
        ]
      }
    });
    expect(result.truncated).toBe(false);
    expect(result.sources[0]).toEqual({
      url: "https://x.com",
      title: "Brave One",
      snippet: "desc",
      publishedAt: "2026-08-06T00:05:04"
    });
  });

  it("ignores human-readable age for publishedAt", () => {
    const result = mapBraveResponse({
      web: { results: [{ url: "https://x.com", age: "2 hours ago" }] }
    });
    expect(result.sources[0].publishedAt).toBeUndefined();
    expect(result.sources[0].url).toBe("https://x.com");
  });

  it("drops url-less entries", () => {
    const result = mapBraveResponse({
      web: { results: [{ title: "no url" }, { url: "https://y.com" }] }
    });
    expect(result.sources).toHaveLength(1);
  });

  it("handles empty and missing responses", () => {
    expect(mapBraveResponse({}).sources).toEqual([]);
    expect(mapBraveResponse({ web: null }).sources).toEqual([]);
    expect(mapBraveResponse({ web: { results: [] } }).sources).toEqual([]);
  });
});

describe("pickPublishedAt", () => {
  it("prefers page_age (ISO) over human-readable age", () => {
    expect(pickPublishedAt({ page_age: "2026-08-01T00:00:00", age: "3 days ago" })).toBe("2026-08-01T00:00:00");
  });

  it("returns undefined for non-ISO values and empty objects", () => {
    expect(pickPublishedAt({ age: "2 hours ago" })).toBeUndefined();
    expect(pickPublishedAt({})).toBeUndefined();
    expect(pickPublishedAt(null)).toBeUndefined();
  });
});

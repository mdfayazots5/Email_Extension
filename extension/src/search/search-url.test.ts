import { describe, expect, it } from "vitest";
import { buildLinkedInSearchUrl, buildLinkedInSearchUrlFromParams, captureLinkedInFilterParams, filterNavigationStatus, filterParameterNames, searchUrlHasFilterParams, summarizeFilterParams } from "./search-url";

describe("buildLinkedInSearchUrl", () => {
  it("encodes query operators, quotes, hashes and parentheses", () => {
    const query = '("Data Analyst" OR "F#") AND C++ #jobs (remote)';
    const result = new URL(buildLinkedInSearchUrl(query, {
      date_posted: "week",
      sort_by: "recent",
      content_type: "all",
      from_member: "",
      other_note: ""
    }));

    expect(result.searchParams.get("keywords")).toBe(query);
    expect(result.searchParams.get("datePosted")).toBe('"past-week"');
    expect(result.searchParams.get("sortBy")).toBe('"date_posted"');
    expect(result.hash).toBe("");
  });

  it("omits default filters from the search URL", () => {
    const result = new URL(buildLinkedInSearchUrl("dotnet", {
      date_posted: "any",
      sort_by: "relevance",
      content_type: "all",
      from_member: "",
      other_note: ""
    }));
    expect(result.searchParams.get("datePosted")).toBeNull();
    expect(result.searchParams.get("sortBy")).toBeNull();
  });

  it.each([
    ["datePosted=%22past-week%22&sortBy=%22date_posted%22", "Past week · Latest · All content"],
    ["contentType=%22ALL%22&fromMember=%22urn%3Ali%3Amember%3A123%22", "Any date · Default sort · All content"],
    ["datePosted=%22past-month%22&sortBy=%22relevance%22&contentType=%22VIDEO%22&customFacet=one", "Past month · Relevance · VIDEO"],
    ["sortBy=%5B%22relevance%22%5D", "Any date · Relevance · All content"]
  ])("replays raw captured params without changing them (%s)", (params, expectedSummary) => {
    const query = '("Data Analyst" OR "F#") AND hiring #remote (UK)';
    const url = new URL(buildLinkedInSearchUrlFromParams(query, params));
    expect(url.searchParams.get("keywords")).toBe(query);
    expect(url.searchParams.get("origin")).toBe("FACETED_SEARCH");
    expect(captureLinkedInFilterParams(url.toString())).toBe(params);
    expect(searchUrlHasFilterParams(url.toString(), params)).toBe(true);
    expect(filterParameterNames(params)).toEqual([...new Set(new URLSearchParams(params).keys())]);
    expect(summarizeFilterParams(params)).toBe(expectedSummary);
  });

  it("detects missing filter parameters after navigation", () => {
    expect(searchUrlHasFilterParams(
      buildLinkedInSearchUrlFromParams("new search", "datePosted=%22past-week%22&sortBy=%22date_posted%22"),
      "datePosted=%22past-week%22&sortBy=%22date_posted%22"
    )).toBe(true);
    expect(searchUrlHasFilterParams(
      buildLinkedInSearchUrlFromParams("new search", ""),
      "datePosted=%22past-week%22"
    )).toBe(false);
    expect(filterNavigationStatus(
      buildLinkedInSearchUrlFromParams("new search", ""),
      "datePosted=%22past-week%22",
      false
    )).toBe("lost");
    expect(filterNavigationStatus(buildLinkedInSearchUrlFromParams("new search", ""), "", true)).toBe("confirm");
  });

  it("captures all parameters except keywords and origin", () => {
    expect(captureLinkedInFilterParams("https://www.linkedin.com/search/results/content/?keywords=x&origin=FACETED_SEARCH&datePosted=%22past-week%22&facet=latest"))
      .toBe("datePosted=%22past-week%22&facet=latest");
  });
});

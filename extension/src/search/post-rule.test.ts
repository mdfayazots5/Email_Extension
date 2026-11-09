import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_WORDS } from "../../../shared/post-defaults";
import { checkRule, evaluatePost, matchesRule, parseRule, RuleSyntaxError } from "./post-rule";

const RULE = '("Data Analyst" OR "BI Analyst" OR "Power BI") AND London AND ("hiring" OR "immediate")';

describe("post rule matching", () => {
  it("accepts a post that satisfies every AND group", () => {
    expect(matchesRule(RULE, "We are hiring a Data Analyst in London. Mail jobs@acme.com")).toBe(true);
    expect(matchesRule(RULE, "Immediate joiner needed: Power BI developer, London")).toBe(true);
  });

  it("rejects a post missing one AND group", () => {
    expect(matchesRule(RULE, "We are hiring a Data Analyst in Leeds")).toBe(false);
    expect(matchesRule(RULE, "Data Analyst in London, apply now")).toBe(false);
  });

  it("handles terms that start or end with symbols", () => {
    expect(matchesRule('"C++"', "Strong C++/Rust skills")).toBe(true);
    expect(matchesRule('"C++"', "ABC++ test")).toBe(false);
    expect(matchesRule('"#hiring"', "Big news #hiring today")).toBe(true);
  });

  it("uses whole words unless a * prefix is given", () => {
    expect(matchesRule("hire", "we are hiring")).toBe(false);
    expect(matchesRule("hir*", "we are hiring")).toBe(true);
    expect(matchesRule("Java", "JavaScript developer")).toBe(false);
  });

  it("ignores case, spacing, hyphens and LinkedIn bold letters", () => {
    expect(matchesRule('("Data Analyst" OR "BI Developer") AND Bangalore', "𝐃𝐚𝐭𝐚   𝐀𝐧𝐚𝐥𝐲𝐬𝐭 opening — BANGALORE")).toBe(true);
    expect(matchesRule('"full stack"', "full-stack engineer")).toBe(true);
  });

  it("treats words next to each other as AND and supports NOT", () => {
    expect(matchesRule("nurse London", "Nurse needed in London")).toBe(true);
    expect(matchesRule("nurse London", "Nurse needed in Leeds")).toBe(false);
    expect(matchesRule("developer NOT intern", "Developer intern wanted")).toBe(false);
    expect(matchesRule("developer NOT intern", "Senior developer wanted")).toBe(true);
  });

  it("accepts lower-case operators and curly quotes", () => {
    expect(matchesRule("“react” or angular and remote", "Angular role, remote")).toBe(true);
  });

  it("reports found and missing words", () => {
    const result = checkRule(RULE, "Hiring a Data Analyst in Delhi");
    expect(result).toMatchObject({ valid: true, matches: false, found: ["Data Analyst", "hiring"] });
    expect(result.valid && result.missing).toContain("London");
  });

  it("explains syntax errors", () => {
    expect(() => parseRule('("Java" OR Kotlin')).toThrow(RuleSyntaxError);
    expect(checkRule("developer AND", "x")).toMatchObject({ valid: false, error: expect.stringContaining("operator") });
    expect(checkRule('"unclosed', "x")).toMatchObject({ valid: false, error: expect.stringContaining("quote") });
    expect(checkRule("a )", "x")).toMatchObject({ valid: false, error: expect.stringContaining("closing bracket") });
    expect(matchesRule("OR", "anything")).toBeNull();
  });
});

describe("post check (Settings → Collecting)", () => {
  const defaults = { requireJobWords: true, jobWords: DEFAULT_JOB_WORDS, matchQuery: false, queryText: "", customRule: "" };

  it("collects any job post with the default hiring words, whatever the job", () => {
    expect(evaluatePost(defaults, "We are hiring a staff nurse. Send your CV to hr@clinic.org").accepted).toBe(true);
    expect(evaluatePost(defaults, "Vacancy: Accounts Executive, Dubai").accepted).toBe(true);
    expect(evaluatePost(defaults, "Immediate joiner needed for a welder role").accepted).toBe(true);
  });

  it("skips posts that are not job posts", () => {
    const result = evaluatePost(defaults, "Great conference today! Slides: me@example.com");
    expect(result.accepted).toBe(false);
    expect(result.checks[0]).toMatchObject({ id: "job", passed: false });
  });

  it("can also require the record's search query", () => {
    const options = { ...defaults, matchQuery: true, queryText: '"Data Analyst" AND London' };
    expect(evaluatePost(options, "Hiring Data Analyst, London").accepted).toBe(true);
    expect(evaluatePost(options, "Hiring Data Analyst, Paris").accepted).toBe(false);
  });

  it("applies an extra rule to every post", () => {
    const options = { ...defaults, customRule: '"remote" OR "work from home"' };
    expect(evaluatePost(options, "Hiring now, fully remote").accepted).toBe(true);
    expect(evaluatePost(options, "Hiring now, on site only").accepted).toBe(false);
  });

  it("skips an invalid rule instead of blocking every post", () => {
    const result = evaluatePost({ ...defaults, customRule: "remote AND" }, "Hiring now");
    expect(result.accepted).toBe(true);
    expect(result.checks.find((check) => check.id === "custom")).toMatchObject({ passed: null, error: expect.any(String) });
  });

  it("collects every post with an email when all checks are off", () => {
    expect(evaluatePost({ ...defaults, requireJobWords: false }, "Anything at all").accepted).toBe(true);
  });

  it("uses custom job words", () => {
    const options = { ...defaults, jobWords: ["internship", "graduate scheme"] };
    expect(evaluatePost(options, "Our graduate scheme is open").accepted).toBe(true);
    expect(evaluatePost(options, "We are hiring seniors").accepted).toBe(false);
  });
});

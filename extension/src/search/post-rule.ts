/**
 * Boolean keyword rules for deciding whether a LinkedIn post should be collected.
 *
 * Syntax (same style as a LinkedIn search):
 *   ("Data Analyst" OR "BI Developer") AND London AND ("hiring" OR "immediate")
 *
 * - AND, OR, NOT (any letter case), parentheses
 * - "quoted phrases" or single words; words next to each other mean AND
 * - word* matches any word starting with "word" (hir* → hiring, hire, hired)
 * - matching ignores letter case, extra spaces, and LinkedIn's bold/italic Unicode letters
 */

export type RuleNode =
  | { type: "term"; text: string }
  | { type: "and" | "or"; children: RuleNode[] }
  | { type: "not"; child: RuleNode };

export class RuleSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = "RuleSyntaxError";
  }
}

type Token =
  | { kind: "lparen" | "rparen" | "and" | "or" | "not"; position: number }
  | { kind: "term"; text: string; position: number };

const OPEN_QUOTES = "\"“”„";

function tokenize(rule: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < rule.length) {
    const char = rule[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "(") { tokens.push({ kind: "lparen", position: index }); index += 1; continue; }
    if (char === ")") { tokens.push({ kind: "rparen", position: index }); index += 1; continue; }
    if (OPEN_QUOTES.includes(char)) {
      const start = index;
      index += 1;
      let text = "";
      while (index < rule.length && !OPEN_QUOTES.includes(rule[index])) { text += rule[index]; index += 1; }
      if (index >= rule.length) throw new RuleSyntaxError("A quote is not closed.", start);
      index += 1;
      if (!text.trim()) throw new RuleSyntaxError("Empty quotes \"\" are not allowed.", start);
      tokens.push({ kind: "term", text: text.trim(), position: start });
      continue;
    }
    const start = index;
    let word = "";
    while (index < rule.length && !/\s/.test(rule[index]) && rule[index] !== "(" && rule[index] !== ")" && !OPEN_QUOTES.includes(rule[index])) {
      word += rule[index];
      index += 1;
    }
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "&&") tokens.push({ kind: "and", position: start });
    else if (upper === "OR" || upper === "||") tokens.push({ kind: "or", position: start });
    else if (upper === "NOT") tokens.push({ kind: "not", position: start });
    else tokens.push({ kind: "term", text: word, position: start });
  }
  return tokens;
}

/** Parses a rule. Throws RuleSyntaxError with a readable message when the rule is invalid. */
export function parseRule(rule: string): RuleNode {
  const tokens = tokenize(rule);
  if (!tokens.length) throw new RuleSyntaxError("The rule is empty.", 0);
  let position = 0;
  const peek = () => tokens[position];
  const describe = (token: Token | undefined) => token ? token.kind === "term" ? `"${token.text}"` : token.kind.toUpperCase().replace("LPAREN", "(").replace("RPAREN", ")") : "the end";

  const parseOr = (): RuleNode => {
    const children = [parseAnd()];
    while (peek()?.kind === "or") {
      position += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  };
  const parseAnd = (): RuleNode => {
    const children = [parseNot()];
    for (;;) {
      const next = peek();
      if (next?.kind === "and") { position += 1; children.push(parseNot()); continue; }
      // Words next to each other mean AND, as in a LinkedIn search.
      if (next && (next.kind === "term" || next.kind === "lparen" || next.kind === "not")) { children.push(parseNot()); continue; }
      break;
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  };
  const parseNot = (): RuleNode => {
    if (peek()?.kind === "not") {
      position += 1;
      return { type: "not", child: parseNot() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): RuleNode => {
    const token = peek();
    if (!token) throw new RuleSyntaxError("The rule ends with an operator. Add a word after it.", tokens.at(-1)?.position ?? 0);
    if (token.kind === "lparen") {
      position += 1;
      if (peek()?.kind === "rparen") throw new RuleSyntaxError("Empty brackets () are not allowed.", token.position);
      const inner = parseOr();
      if (peek()?.kind !== "rparen") throw new RuleSyntaxError("A bracket ( is not closed.", token.position);
      position += 1;
      return inner;
    }
    if (token.kind === "term") {
      position += 1;
      return { type: "term", text: token.text };
    }
    throw new RuleSyntaxError(`Expected a word but found ${describe(token)}.`, token.position);
  };

  const tree = parseOr();
  if (position < tokens.length) {
    const token = tokens[position];
    throw new RuleSyntaxError(token.kind === "rparen" ? "There is an extra closing bracket )." : `Unexpected ${describe(token)}.`, token.position);
  }
  return tree;
}

/** Lower-case, unify LinkedIn's styled Unicode letters (𝐡𝐢𝐫𝐢𝐧𝐠 → hiring), quotes and spaces. */
export function normalizeRuleText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[  -​]/g, " ")
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const termPatternCache = new Map<string, RegExp>();

/**
 * Word-boundary match that also works for terms that start or end with a symbol, such as "C++" or "#hiring":
 * a boundary is only required on a side where the term starts or ends with a letter/digit.
 */
function termPattern(term: string): RegExp {
  const cached = termPatternCache.get(term);
  if (cached) return cached;
  const normalized = normalizeRuleText(term).trim();
  const prefix = normalized.endsWith("*");
  const core = prefix ? normalized.slice(0, -1) : normalized;
  const body = core.split(/[\s-]+/).filter(Boolean).map(escapeRegExp).join("[\\s\\-]+");
  const startsWord = /^[\p{L}\p{N}]/u.test(core);
  const endsWord = /[\p{L}\p{N}]$/u.test(core);
  const pattern = new RegExp(
    `${startsWord ? "(?<![\\p{L}\\p{N}])" : ""}${body}${prefix ? "[\\p{L}\\p{N}]*" : endsWord ? "(?![\\p{L}\\p{N}])" : ""}`,
    "u"
  );
  termPatternCache.set(term, pattern);
  return pattern;
}

export function termMatches(term: string, normalizedText: string): boolean {
  return termPattern(term).test(normalizedText);
}

function evaluate(node: RuleNode, text: string): boolean {
  switch (node.type) {
    case "term": return termMatches(node.text, text);
    case "and": return node.children.every((child) => evaluate(child, text));
    case "or": return node.children.some((child) => evaluate(child, text));
    case "not": return !evaluate(node.child, text);
  }
}

export function collectTerms(node: RuleNode, terms: string[] = []): string[] {
  if (node.type === "term") { if (!terms.includes(node.text)) terms.push(node.text); }
  else if (node.type === "not") collectTerms(node.child, terms);
  else node.children.forEach((child) => collectTerms(child, terms));
  return terms;
}

export type RuleCheck =
  | { valid: true; matches: boolean; found: string[]; missing: string[] }
  | { valid: false; error: string; position: number };

/** Checks a post against a rule and reports which words were found, for the tester and logs. */
export function checkRule(rule: string, postText: string): RuleCheck {
  let tree: RuleNode;
  try {
    tree = parseRule(rule);
  } catch (error) {
    if (error instanceof RuleSyntaxError) return { valid: false, error: error.message, position: error.position };
    throw error;
  }
  const text = normalizeRuleText(postText);
  const terms = collectTerms(tree);
  return {
    valid: true,
    matches: evaluate(tree, text),
    found: terms.filter((term) => termMatches(term, text)),
    missing: terms.filter((term) => !termMatches(term, text))
  };
}

const compiledRules = new Map<string, RuleNode | RuleSyntaxError>();

/** Cached match for the scan loop. Returns null when the rule itself is invalid. */
export function matchesRule(rule: string, postText: string): boolean | null {
  let compiled = compiledRules.get(rule);
  if (!compiled) {
    try { compiled = parseRule(rule); } catch (error) {
      if (!(error instanceof RuleSyntaxError)) throw error;
      compiled = error;
    }
    compiledRules.set(rule, compiled);
  }
  if (compiled instanceof RuleSyntaxError) return null;
  return evaluate(compiled, normalizeRuleText(postText));
}

export type PostCheckOptions = {
  /** Require at least one of jobWords in the post. */
  requireJobWords: boolean;
  jobWords: readonly string[];
  /** Require the post to match the record's search query. */
  matchQuery: boolean;
  queryText: string;
  /** Optional extra rule every post must match; empty means none. */
  customRule: string;
};

export type PostCheck = {
  id: "job" | "query" | "custom";
  label: string;
  /** null when the rule is invalid and therefore not applied. */
  passed: boolean | null;
  found: string[];
  missing: string[];
  error?: string;
};

/**
 * Decides whether a post (already known to contain an email) should be collected.
 * Every enabled check must pass. An invalid rule is reported and skipped rather
 * than blocking every post.
 */
export function evaluatePost(options: PostCheckOptions, postText: string): { accepted: boolean; checks: PostCheck[] } {
  const text = normalizeRuleText(postText);
  const checks: PostCheck[] = [];
  const words = options.jobWords.map((word) => word.trim()).filter(Boolean);
  if (options.requireJobWords && words.length) {
    const found = words.filter((word) => termMatches(word, text));
    checks.push({ id: "job", label: "Looks like a job post", passed: found.length > 0, found, missing: found.length ? [] : words });
  }
  const ruleCheck = (id: "query" | "custom", label: string, rule: string) => {
    const result = checkRule(rule, postText);
    checks.push(result.valid
      ? { id, label, passed: result.matches, found: result.found, missing: result.missing }
      : { id, label, passed: null, found: [], missing: [], error: result.error });
  };
  if (options.matchQuery && options.queryText.trim()) ruleCheck("query", "Matches the record's search query", options.queryText);
  if (options.customRule.trim()) ruleCheck("custom", "Matches the extra rule", options.customRule);
  return { accepted: checks.every((check) => check.passed !== false), checks };
}

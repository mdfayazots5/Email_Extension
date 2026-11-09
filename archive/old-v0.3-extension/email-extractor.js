(() => {
  "use strict";

  const EMAIL_PATTERN =
    /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
  const ALLOWED_TLDS = new Set(
    `com in io net org co ai edu gov info biz me us uk ca de ro tech app dev xyz online work group global solutions
    aero asia at au be br ch cl cloud club cn consulting digital es eu fi firm fr gg hr id ie il im inc int io it jp jobs kr live ltd mobi museum name nl no nz one pro ru se site software store tech tel travel tv ua us vc website world ws zip academy agency app art asia auto band bar bio blog business ca cafe capital center ceo charity chat city cloud club codes company consulting cool digital email engineering enterprises esq eu events family finance firm fitness food foundation fun gallery games garden global group guru health help house info institute international investments job jobs land law life link live ltd ltd uk market marketing mba media mil mobile mortgage music name news ngo ninja now online org partners party photography photos place plus press pro productions pub pw recipes red restaurant review reviews rocks science services shop social software solutions space store systems tech technology tel today top town travel university uno us vacations ventures website wiki work world xyz za zone.`
      .split(/\s+/)
      .map((tld) => tld.toLowerCase().replace(/\.$/, ""))
  );
  const ALLOWED_TLD_PREFIXES = [...ALLOWED_TLDS]
    .sort((left, right) => right.length - left.length);
  const TRAILING_JUNK = /[.,;:)\]>"'”’]+$/;

  function validateCandidate(value) {
    let candidate = value.trim().replace(TRAILING_JUNK, "");
    const atIndex = candidate.indexOf("@");
    const lastAtIndex = candidate.lastIndexOf("@");
    if (atIndex <= 0 || atIndex !== lastAtIndex) {
      return null;
    }

    const domainStart = atIndex + 1;
    const lastDot = candidate.lastIndexOf(".");
    if (lastDot < domainStart) {
      return null;
    }

    const tld = candidate.slice(lastDot + 1).toLowerCase();
    if (!ALLOWED_TLDS.has(tld)) {
      const allowedPrefix = ALLOWED_TLD_PREFIXES.find((allowed) => tld.startsWith(allowed));
      if (!allowedPrefix) {
        return null;
      }
      candidate = candidate.slice(0, lastDot + 1 + allowedPrefix.length);
    }

    const normalized = candidate.toLowerCase();
    const normalizedAt = normalized.indexOf("@");
    const localPart = normalized.slice(0, normalizedAt);
    const domain = normalized.slice(normalizedAt + 1);

    if (candidate.length > 254 ||
        localPart.length > 64 ||
        !/^[a-z0-9][a-z0-9._%+-]*$/.test(localPart) ||
        localPart.endsWith(".") ||
        localPart.includes("..") ||
        domain.includes("..") ||
        !/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(candidate)) {
      return null;
    }

    return candidate;
  }

  function sanitizeEmail(value) {
    if (typeof value !== "string") {
      return null;
    }

    for (const match of value.matchAll(EMAIL_PATTERN)) {
      const candidate = validateCandidate(match[0]);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  function extractEmails(text) {
    if (typeof text !== "string" || text.length === 0) {
      return [];
    }

    const seen = new Set();
    const emails = [];
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      const email = sanitizeEmail(match[0]);
      if (!email) {
        continue;
      }
      const key = email.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        emails.push(email);
      }
    }
    return emails;
  }

  const api = { extractEmails, sanitizeEmail };
  globalThis.EmailExtractor = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

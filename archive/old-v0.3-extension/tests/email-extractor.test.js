const test = require("node:test");
const assert = require("node:assert/strict");
const { extractEmails, sanitizeEmail } = require("../email-extractor.js");

const validCases = [
  ["**amreen@prolificxpert.com", "amreen@prolificxpert.com"],
  ["###said.johnbi@cerebra-consulting.com", "said.johnbi@cerebra-consulting.com"],
  ["-tapasya.bakore@truminds.com", "tapasya.bakore@truminds.com"],
  ["/info@hexatechglobal.com", "info@hexatechglobal.com"],
  [".bad@domain.com", "bad@domain.com"],
  [
    "consultants.futurehiremanpower@atomicmail.ioSubject",
    "consultants.futurehiremanpower@atomicmail.io"
  ],
  ["chathurya@mechispike.comKnow", "chathurya@mechispike.com"],
  ["Email: hr@alendei.com.", "hr@alendei.com"],
  ["TATUS.ENG@RELEVANTZ.COM", "TATUS.ENG@RELEVANTZ.COM"]
];

for (const [input, expected] of validCases) {
  test(`sanitizes ${input}`, () => {
    assert.equal(sanitizeEmail(input), expected);
    assert.deepEqual(extractEmails(input), [expected]);
  });
}

test("keeps a valid suffix separate from adjacent DOM line text", () => {
  assert.deepEqual(
    extractEmails("consultants.futurehiremanpower@atomicmail.io\nSubject chathurya@mechispike.com\nKnow"),
    [
      "consultants.futurehiremanpower@atomicmail.io",
      "chathurya@mechispike.com"
    ]
  );
});

test("deduplicates sanitized addresses by trimmed lowercase key and keeps first spelling", () => {
  assert.deepEqual(
    extractEmails("**shanmukh@navarsecurity.com shanmukh@navarsecurity.com"),
    ["shanmukh@navarsecurity.com"]
  );
  assert.deepEqual(
    extractEmails("TATUS.ENG@RELEVANTZ.COM tatus.eng@relevantz.com"),
    ["TATUS.ENG@RELEVANTZ.COM"]
  );
});

test("rejects invalid local parts, double dots, and unknown TLDs", () => {
  assert.equal(sanitizeEmail("bad..name@domain.com"), null);
  assert.equal(sanitizeEmail("bad.@domain.com"), null);
  assert.equal(sanitizeEmail("user@domain.unknown"), null);
});

/**
 * Default "this is a job post" words. A post must contain at least one of them
 * (when that check is on) before its emails are collected. Users can edit the
 * list in Settings → Collecting; nothing here is tied to a particular job or skill.
 */
export const DEFAULT_JOB_WORDS: readonly string[] = [
  "hiring",
  "hire",
  "now hiring",
  "we are hiring",
  "recruiting",
  "recruitment",
  "vacancy",
  "vacancies",
  "job opening",
  "openings",
  "immediate joiner",
  "immediate joining",
  "immediate",
  "looking for",
  "send your resume",
  "send your cv",
  "share your resume",
  "share your cv",
  "apply"
];

export const selectorSets = {
  pageReady: "[data-testid='typeahead-input'][placeholder='Search']",
  searchInput: "[data-testid='typeahead-input'][placeholder='Search']",
  filterPills: "[role='button']",
  postsTab: "[role='button'][aria-label='Filter by Posts']",
  controls: "button, a[href], [role='button'], [role='combobox']",
  options: "[role='option'], [role='menuitem'], [role='menuitemradio'], [role='radio'], [role='button'], button, li",
  textboxes: "input, textarea, [role='textbox'], [contenteditable='true']",
  overlays: "[role='dialog'], [role='menu'], [role='listbox'], [popover]",
  busyIndicators: "[aria-busy='true'], [role='progressbar'], [aria-label*='Loading']",
  chips: "[aria-label*='Remove'], [aria-label*='remove'], [data-testid*='filter-chip'], [data-test*='filter-chip'], [role='status']",
  resultLists: "[data-testid*='feed'], [data-test*='feed'], main",
  visibleBody: "body",
  postCards: "article, [data-urn*='activity'], [data-id*='urn:li:activity'], [data-testid*='feed-update']",
  postText: "[data-testid*='commentary'], [class*='feed-shared-update-v2__description'], [class*='update-components-text'], .attributed-text-segment-list__content, article",
  postPermalinks: "a[href*='/feed/update/'], a[href*='/posts/'], a[href*='activity-']",
  postDates: "time[datetime], [data-testid*='post-date'], [class*='update-components-actor__sub-description'], [class*='feed-shared-actor__sub-description']",
  postAuthors: "[data-testid*='actor-name'], [class*='update-components-actor__name'], [class*='feed-shared-actor__name']",
  expandButtons: "button, [role='button']",
  loadMoreButtons: "button, [role='button']"
} as const;

export const filterPillLabels = {
  date_posted: ["Filter by Date posted"],
  sort_by: ["Filter by Top Match", "Filter by Latest", "Filter by Sort by"],
  content_type: ["Filter by Content type"],
  from_member: ["Filter by From member"]
} as const;

export const postContentLabel = "Filter by Posts";
export const sortRelevancePillLabel = "Filter by Top Match";
export const sortFilterPillValues: Record<string, string> = {
  recent: "Filter by Latest",
  relevance: sortRelevancePillLabel
};
export const allFiltersLabels = ["All filters"];
export const resetLabels = ["Reset"];
export const showResultsLabels = ["Show results", "Apply"];
export const memberInputHints = ["member", "people"];

export const filterControlNames = {
  date_posted: ["Date posted", "Date"],
  sort_by: ["Sort by"],
  content_type: ["Content type", "Content"],
  from_member: ["From member", "Posted by"]
} as const;

export const filterValueAliases: Record<string, string[]> = {
  any: ["Any time", "Any date", "Any"],
  "24h": ["Past 24 hours", "Past 24 Hours", "24 hours"],
  week: ["Past week", "Past Week", "Last week"],
  month: ["Past month", "Past Month", "Last month"],
  recent: ["Most recent", "Recent", "Latest"],
  relevance: ["Relevance", "Most relevant", "Top Match"],
  posts: ["Posts"],
  all: ["All content", "All"],
  "all content": ["All content", "All"],
  images: ["Images"],
  videos: ["Videos"],
  documents: ["Documents"],
  job_posts: ["Job posts"],
  "job posts": ["Job posts"],
  live_videos: ["Live videos"],
  "live videos": ["Live videos"]
};

export const safetyPatterns = [
  /security check/i,
  /security verification/i,
  /unusual activity/i,
  /unusual search traffic/i,
  /verify (your )?identity/i,
  /confirm you are not a robot/i,
  /captcha/i,
  /rate limit/i,
  /too many requests/i,
  /temporarily restricted/i,
  /temporarily blocked/i,
  /challenge required/i
] as const;

export const expandPostLabels = ["see more", "…more", "...more", "more"];
export const loadMoreLabels = ["show more results", "show more", "load more"];

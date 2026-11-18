// All guide text in one place. Previews in the welcome tour use made-up example data only.

export type WelcomePreview = "intro" | "flow" | "queries" | "linkedin" | "filters" | "results" | "safety" | "finish";

export type WelcomeStep = { title: string; body: string[]; preview: WelcomePreview };

export const WELCOME_STEPS: WelcomeStep[] = [
  {
    title: "Welcome to Email Extension",
    preview: "intro",
    body: [
      "This extension helps you find hiring posts on LinkedIn and collect the contact emails that recruiters wrote in them.",
      "Everything stays on this computer. Nothing is uploaded anywhere."
    ]
  },
  {
    title: "How it works",
    preview: "flow",
    body: [
      "You save searches (Queries), open a LinkedIn Posts search, set LinkedIn's filters once, and press Start.",
      "The extension scrolls slowly, reads each post, keeps the ones that look like job posts with an email, and saves the emails."
    ]
  },
  {
    title: "1 · Queries: what to search",
    preview: "queries",
    body: [
      "A query record is one LinkedIn search, usually one city, grouped by country.",
      "Use AND, OR and \"quoted phrases\", for example (\"Job title\" OR \"Other title\") AND \"City\" AND hiring. You can add sample records at the end of this tour."
    ]
  },
  {
    title: "2 · Start on LinkedIn",
    preview: "linkedin",
    body: [
      "Sign in to LinkedIn yourself and open any Posts search. A small Email Extension bar appears at the top right.",
      "Choose a country and a record in the bar (or on the View page) and press Start."
    ]
  },
  {
    title: "3 · Set the filters once",
    preview: "filters",
    body: [
      "For each country, set LinkedIn's filters yourself (Date posted, Sort by, and so on), then click Continue in the bar.",
      "The extension remembers them and reuses them for the other records of that country. Next time choose Use saved filters."
    ]
  },
  {
    title: "4 · See and export results",
    preview: "results",
    body: [
      "View shows today's new emails and the live run. History shows any day, week or month by country.",
      "Copy or export CSV/XLSX at any time. Upload a master list in Settings → Data to see only emails you don't already have."
    ]
  },
  {
    title: "5 · Stay safe",
    preview: "safety",
    body: [
      "Slow delays and daily limits are on by default (Settings → Speed & limits). If LinkedIn shows a security check, the run stops and rests.",
      "Never try to get around captchas or warnings, and only use the data where you have a lawful reason to."
    ]
  },
  {
    title: "You're ready",
    preview: "finish",
    body: [
      "Add a few sample queries to try it out, then change the job titles to yours.",
      "You can replay this guide any time with the ? button at the top."
    ]
  }
];

export type TourStep = { target: string; title: string; body: string };

export type TourPage = "view" | "queries" | "history" | "settings";

export const PAGE_TOURS: Record<TourPage, TourStep[]> = {
  view: [
    { target: "nav", title: "Pages", body: "View is your dashboard. Queries holds your searches, History shows past results, Settings changes how collecting works." },
    { target: "connection", title: "Connection", body: "Green means the local service is running. It starts by itself; click it to reconnect if it ever turns red." },
    { target: "metrics", title: "Today at a glance", body: "New emails (not in your master list), everything collected today, the run status and how many records were searched." },
    { target: "search-controls", title: "Search controls", body: "Pick a country and starting record, then Start. Open a LinkedIn Posts search tab first." },
    { target: "live-run", title: "Live run", body: "While a run is going you see scrolls, posts and emails counted live, with Pause, Resume and Stop." },
    { target: "today-results", title: "Today's results", body: "The new emails saved today with their post links. Copy or export them from here." },
    { target: "guide", title: "Need help again?", body: "Press ? any time to replay the welcome guide or the tour of the page you are on." }
  ],
  queries: [
    { target: "queries-add", title: "Add country", body: "Add a country with its first search record, usually a city. Add more records to the same country later." },
    { target: "queries-import", title: "Import and export", body: "Move your records between computers or share them with a CSV file." },
    { target: "queries-list", title: "Your records", body: "Records run in order within a country. Edit, reorder, switch off or delete them here." }
  ],
  history: [
    { target: "history-filters", title: "Choose a period", body: "Pick day, week or month, a date and optionally one country." },
    { target: "history-countries", title: "Results", body: "Totals per country and day by day. Export the selected period as CSV." }
  ],
  settings: [
    { target: "settings-nav", title: "Settings sections", body: "General, Collecting (which posts count), Speed & limits (safety), Activity log, Data (master list, backups) and Advanced." },
    { target: "settings-panel", title: "Change and save", body: "Change values here. A Save bar appears at the bottom whenever something changed." }
  ]
};

export type LinkedInTourStep = { target: "country" | "record" | "start" | "stop" | "help"; title: string; body: string };

export const LINKEDIN_TOUR: LinkedInTourStep[] = [
  { target: "country", title: "1 · Country", body: "Choose which country's search records to run." },
  { target: "record", title: "2 · Record", body: "Choose the record to start with. Later records of the same country can follow automatically." },
  { target: "start", title: "3 · Start", body: "Start the run. For a new country you set LinkedIn's filters yourself, then click Continue here." },
  { target: "stop", title: "4 · Stop", body: "Stop any time. Pause and Resume are in the extension popup or View page." },
  { target: "help", title: "Help", body: "Press ? to see these tips again. Drag the title to move this bar." }
];

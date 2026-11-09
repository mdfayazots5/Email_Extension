import { selectorSets } from "./selectors";

const postUrnPattern = /urn(?::|%3A)li(?::|%3A)(activity|ugcPost|share)(?::|%3A)(\d{10,})/i;
const activityPathPattern = /[-_]activity-(\d{10,})/i;

function urnFromValue(value: string): string {
  const match = value.match(postUrnPattern);
  if (match) return `urn:li:${match[1].toLowerCase() === "ugcpost" ? "ugcPost" : match[1].toLowerCase()}:${match[2]}`;
  const activity = value.match(activityPathPattern);
  return activity ? `urn:li:activity:${activity[1]}` : "";
}

/** LinkedIn's tracking scope stores JSON whose payload is a byte array (`{"type":"Buffer","data":[…]}`). */
function urnFromTrackingScope(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "";
  }
  const pending: unknown[] = [parsed];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      if (item.length > 20 && item.every((byte) => typeof byte === "number" && byte >= 0 && byte < 256)) {
        const urn = urnFromValue(String.fromCharCode(...item));
        if (urn) return urn;
      } else {
        pending.push(...item);
      }
    } else if (item && typeof item === "object") {
      pending.push(...Object.values(item));
    } else if (typeof item === "string") {
      const urn = urnFromValue(item);
      if (urn) return urn;
    }
  }
  return "";
}

function urnFromAttributes(element: Element): string {
  for (const attribute of element.attributes) {
    if (attribute.name === "href") continue;
    const urn = attribute.name === "data-view-tracking-scope"
      ? urnFromTrackingScope(attribute.value) || urnFromValue(attribute.value)
      : urnFromValue(attribute.value);
    if (urn) return urn;
  }
  return "";
}

/**
 * The post's own URN from the card markup (data-urn, data-id, componentkey, tracking scope…),
 * checked before links in the post body, which can point to other posts.
 */
export function findPostUrn(post: HTMLElement): string {
  const own = urnFromAttributes(post);
  if (own) return own;
  for (const element of post.querySelectorAll("*")) {
    if (element.closest("[data-testid='expandable-text-box'], .update-components-text, .feed-shared-inline-show-more-text")) continue;
    const urn = urnFromAttributes(element);
    if (urn) return urn;
  }
  return "";
}

export function findPostPermalink(post: HTMLElement): string {
  const urn = findPostUrn(post);
  if (urn) return `https://www.linkedin.com/feed/update/${urn}/`;
  for (const anchor of post.querySelectorAll<HTMLAnchorElement>(selectorSets.postPermalinks)) {
    try {
      const url = new URL(anchor.href, post.ownerDocument.baseURI);
      if (url.hostname === "www.linkedin.com" && /^\/(?:feed\/update|posts)\//.test(url.pathname)) {
        return `${url.origin}${url.pathname}`;
      }
    } catch {
      continue;
    }
  }
  return "";
}

export function postCardLinkDiagnostics(root: ParentNode, limit = 12): {
  canonicalLinkCount: number;
  canonicalLinksOutsideCards: Array<{ hrefPath: string; tag: string; isTimeElement: boolean; parentChain: string[] }>;
  menus: Array<{
    role: string;
    itemCount: number;
    actions: string[];
    anchorRoutes: string[];
  }>;
  actionControls: Array<{
    tag: string;
    role: string;
    action: string;
    route: string;
    parentRoles: string[];
  }>;
  menuToggles: Array<{
    tag: string;
    expanded: string | null;
    cardIndex: number;
  }>;
  cards: Array<{
    cardIndex: number;
    tag: string;
    role: string;
    testId: string;
    componentType: string;
    attributes: string[];
    dateCandidates: Array<{
      tag: string;
      attributes: string[];
      classHints: string[];
      insideAnchor: boolean;
      parentChain: Array<{ tag: string; role: string; testId: string; attributes: string[] }>;
    }>;
    anchors: Array<{
      tag: string;
      hrefKind: "feed-update" | "posts" | "profile" | "other";
      hrefPath: string;
      isTimeElement: boolean;
      hasAriaLabel: boolean;
      hasTitle: boolean;
      textLooksLikeDate: boolean;
      classHints: string[];
      parentChain: Array<{ tag: string; role: string; testId: string; attributes: string[] }>;
    }>;
  }>;
} {
  const cards = findPostCards(root).slice(0, limit);
  const menuToggles = cards.flatMap((card, cardIndex) =>
    [...card.querySelectorAll<HTMLElement>("button, [role='button']")]
      .filter((button) => isPostMenuToggle([
        button.getAttribute("aria-label") ?? "",
        button.getAttribute("title") ?? ""
      ].join(" ")))
      .map((button) => ({
        tag: button.tagName.toLowerCase(),
        expanded: button.getAttribute("aria-expanded"),
        cardIndex
      }))
  );
  const cardDiagnostics = cards.map((card, cardIndex) => {
    const componentKey = card.getAttribute("componentkey") ?? "";
    const componentType = componentKey.startsWith("update-card-focus")
      ? "update-card-focus"
      : componentKey.startsWith("expanded")
        ? "expanded"
        : componentKey ? "other" : "";
    const anchors = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")].slice(0, 30).map((anchor) => {
      let hrefKind: "feed-update" | "posts" | "profile" | "other" = "other";
      let hrefPath = "";
      try {
        const url = new URL(anchor.href, card.ownerDocument.baseURI);
        if (url.hostname === "www.linkedin.com" && /^\/feed\/update\//.test(url.pathname)) {
          hrefKind = "feed-update";
          hrefPath = "/feed/update/:activity";
        } else if (url.hostname === "www.linkedin.com" && /^\/posts\//.test(url.pathname)) {
          hrefKind = "posts";
          hrefPath = "/posts/:post";
        } else if (url.hostname === "www.linkedin.com" && /^\/in\//.test(url.pathname)) {
          hrefKind = "profile";
          hrefPath = "/in/:profile";
        } else {
          hrefPath = "(other LinkedIn link)";
        }
      } catch {
        hrefPath = "(invalid URL)";
      }
      const anchorText = anchor.innerText || anchor.textContent || "";
      const parentChain: Array<{ tag: string; role: string; testId: string; attributes: string[] }> = [];
      let parent = anchor.parentElement;
      while (parent && parent !== card && parentChain.length < 3) {
        parentChain.push({
          tag: parent.tagName.toLowerCase(),
          role: parent.getAttribute("role") ?? "",
          testId: parent.getAttribute("data-testid") ?? "",
          attributes: [...parent.attributes].map((attribute) => attribute.name).sort()
        });
        parent = parent.parentElement;
      }
      return {
        tag: anchor.tagName.toLowerCase(),
        hrefKind,
        hrefPath,
        isTimeElement: anchor.querySelector("time") !== null || anchor.tagName === "TIME",
        hasAriaLabel: anchor.hasAttribute("aria-label"),
        hasTitle: anchor.hasAttribute("title"),
        textLooksLikeDate: /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b\d+[hdwm]\b|\b(?:today|yesterday)\b/i.test(anchorText),
        classHints: [...anchor.classList].filter((name) => /date|time|post|feed|update|actor|timestamp/i.test(name)),
        parentChain
      };
    });
    const dateCandidates = [...card.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const text = element.innerText || element.textContent || "";
        return text.length <= 120
          && /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b\d+[hdwm]\b|\b(?:today|yesterday)\b/i.test(text);
      })
      .slice(0, 12)
      .map((element) => {
        const parentChain: Array<{ tag: string; role: string; testId: string; attributes: string[] }> = [];
        let parent = element.parentElement;
        while (parent && parent !== card && parentChain.length < 3) {
          parentChain.push({
            tag: parent.tagName.toLowerCase(),
            role: parent.getAttribute("role") ?? "",
            testId: parent.getAttribute("data-testid") ?? "",
            attributes: [...parent.attributes].map((attribute) => attribute.name).sort()
          });
          parent = parent.parentElement;
        }
        return {
          tag: element.tagName.toLowerCase(),
          attributes: [...element.attributes].map((attribute) => attribute.name).sort(),
          classHints: [...element.classList].filter((name) => /date|time|post|feed|update|actor|timestamp/i.test(name)),
          insideAnchor: element.closest("a") !== null,
          parentChain
        };
      });
    return {
      cardIndex,
      tag: card.tagName.toLowerCase(),
      role: card.getAttribute("role") ?? "",
      testId: card.getAttribute("data-testid") ?? "",
      componentType,
      attributes: [...card.attributes].map((attribute) => attribute.name).sort(),
      dateCandidates,
      anchors
    };
  });
  const canonicalLinks = [...root.querySelectorAll<HTMLAnchorElement>(selectorSets.postPermalinks)];
  const canonicalLinksOutsideCards = canonicalLinks
    .filter((anchor) => !cards.some((card) => card.contains(anchor)))
    .slice(0, 20)
    .map((anchor) => {
      let hrefPath = "";
      try {
        const url = new URL(anchor.href, anchor.ownerDocument.baseURI);
        const isLinkedIn = url.hostname === "www.linkedin.com";
        const isPostPath = /^\/(?:feed\/update|posts)\//.test(url.pathname);
        hrefPath = isLinkedIn && isPostPath
          ? /^\/feed\/update\//.test(url.pathname) ? "/feed/update/:activity" : "/posts/:post"
          : isLinkedIn ? "(other LinkedIn link)" : "(external URL)";
      } catch {
        hrefPath = "(invalid URL)";
      }
      const parentChain: string[] = [];
      let parent = anchor.parentElement;
      while (parent && parentChain.length < 4) {
        parentChain.push(`${parent.tagName.toLowerCase()}[${[...parent.attributes].map((attribute) => attribute.name).sort().join(",")}]`);
        parent = parent.parentElement;
      }
      return {
        hrefPath,
        tag: anchor.tagName.toLowerCase(),
        isTimeElement: anchor.querySelector("time") !== null || anchor.tagName === "TIME",
        parentChain
      };
    });
  const menus = [...root.querySelectorAll<HTMLElement>(
    "[role='menu'], [role='dialog'], [role='popover'], [data-testid*='menu'], [data-testid*='popover'], [data-testid*='dropdown']"
  )].slice(0, 10).map((menu) => {
    const items = [...menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio'], button, a[href]")];
    const actions = items.map((item) => safeActionCategory([
      item.getAttribute("aria-label") ?? "",
      item.getAttribute("title") ?? "",
      item.textContent ?? ""
    ].join(" ")));
    const anchorRoutes = [...menu.querySelectorAll<HTMLAnchorElement>("a[href]")].map((anchor) => safeRouteCategory(anchor.href));
    return {
      role: menu.getAttribute("role") ?? "",
      itemCount: items.length,
      actions: [...new Set(actions)],
      anchorRoutes: [...new Set(anchorRoutes)]
    };
  });
  const actionControls = [...root.querySelectorAll<HTMLElement>(
    "button, a[href], [role], [aria-label], [title], div, span"
  )].map((control) => {
    const accessibleLabel = control.getAttribute("aria-label") || control.getAttribute("title") || "";
    const textLabel = control.textContent?.trim() ?? "";
    const actionLabel = accessibleLabel || (textLabel.length <= 80 ? textLabel : "");
    const action = safeActionCategory(actionLabel);
    if (action === "other") return null;
    if ([...control.children].some((child) => safeActionCategory(child.textContent?.trim() ?? "") === action)) {
      return null;
    }
    const parentRoles: string[] = [];
    let parent = control.parentElement;
    while (parent && parentRoles.length < 3) {
      const role = parent.getAttribute("role");
      if (role) parentRoles.push(role);
      parent = parent.parentElement;
    }
    return {
      tag: control.tagName.toLowerCase(),
      role: control.getAttribute("role") ?? "",
      action,
      route: control.tagName === "A" ? safeRouteCategory(control.getAttribute("href") ?? "") : "",
      parentRoles
    };
  }).filter((control): control is NonNullable<typeof control> => control !== null).slice(0, 40);
  return {
    canonicalLinkCount: canonicalLinks.length,
    canonicalLinksOutsideCards,
    menus,
    actionControls,
    menuToggles,
    cards: cardDiagnostics
  };
}

function safeRouteCategory(href: string): string {
  try {
    const url = new URL(href, "https://www.linkedin.com");
    if (url.hostname !== "www.linkedin.com") return "external";
    if (/^\/feed\/update\//.test(url.pathname)) return "feed-update";
    if (/^\/posts\//.test(url.pathname)) return "posts";
    if (/^\/in\//.test(url.pathname)) return "profile";
    return "other-linkedin";
  } catch {
    return "invalid";
  }
}

function safeActionCategory(label: string): string {
  const normalized = label.toLocaleLowerCase();
  if (isPostMenuToggle(normalized)) return "open-post-menu";
  if (/^copy\s+(?:link|link to post)\b/.test(normalized)) return "copy-link";
  if (/^(?:share|send)(?:\s|$)/.test(normalized)) return "share";
  if (/^save(?:\s|$)/.test(normalized)) return "save";
  if (/^repost(?:\s|$)/.test(normalized)) return "repost";
  if (/^report(?:\s|$)/.test(normalized)) return "report";
  if (/^message(?:\s|$)/.test(normalized)) return "message";
  return "other";
}

function isPostMenuToggle(label: string): boolean {
  return /\b(?:control menu|post options|more options)\b/i.test(label);
}

export function findPostCards(root: ParentNode): HTMLElement[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(selectorSets.postCards)];
  const cards = new Set(candidates.filter((candidate) =>
    candidate.querySelector(selectorSets.postPermalinks) || candidate.hasAttribute("data-urn")
  ));

  for (const candidate of root.querySelectorAll<HTMLElement>("[role='listitem']")) {
    if (candidate.querySelectorAll("[data-testid='expandable-text-button']").length === 1) {
      cards.add(candidate);
    }
  }

  for (const button of root.querySelectorAll<HTMLElement>("[data-testid='expandable-text-button']")) {
    let ancestor = button.parentElement;
    while (ancestor && ancestor.tagName !== "BODY" && ancestor.tagName !== "HTML") {
      const hasPermalink = ancestor.querySelector(selectorSets.postPermalinks) !== null;
      const expandButtonCount = ancestor.querySelectorAll("[data-testid='expandable-text-button']").length;
      if (hasPermalink && expandButtonCount === 1) {
        cards.add(ancestor);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }

  return [...cards];
}

export function postDiscoveryDiagnostics(root: ParentNode): {
  matchedCards: number;
  expandButtons: number;
  articleElements: number;
  activityUrnElements: number;
  activityIdElements: number;
  feedUpdateElements: number;
  buttonAncestors: Array<{
    buttonIndex: number;
    candidateAncestorTag: string | null;
    candidateHasPermalink: boolean;
    candidateExpandButtonCount: number;
  }>;
} {
  const expandButtons = [...root.querySelectorAll<HTMLElement>("[data-testid='expandable-text-button']")];
  return {
    matchedCards: findPostCards(root).length,
    expandButtons: expandButtons.length,
    articleElements: root.querySelectorAll("article").length,
    activityUrnElements: root.querySelectorAll("[data-urn*='activity']").length,
    activityIdElements: root.querySelectorAll("[data-id*='urn:li:activity']").length,
    feedUpdateElements: root.querySelectorAll("[data-testid*='feed-update']").length,
    buttonAncestors: expandButtons.slice(0, 10).map((button, buttonIndex) => {
      let ancestor = button.parentElement;
      let candidateAncestorTag: string | null = null;
      let candidateHasPermalink = false;
      let candidateExpandButtonCount = 0;
      while (ancestor && ancestor.tagName !== "BODY" && ancestor.tagName !== "HTML") {
        const hasPermalink = ancestor.querySelector(selectorSets.postPermalinks) !== null;
        const expandButtonCount = ancestor.querySelectorAll("[data-testid='expandable-text-button']").length;
        if (hasPermalink && expandButtonCount === 1) {
          candidateAncestorTag = ancestor.tagName.toLocaleLowerCase();
          candidateHasPermalink = true;
          candidateExpandButtonCount = expandButtonCount;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      return { buttonIndex, candidateAncestorTag, candidateHasPermalink, candidateExpandButtonCount };
    })
  };
}

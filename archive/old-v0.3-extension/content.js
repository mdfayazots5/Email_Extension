(() => {
  "use strict";

  const CONTENT_SCRIPT_VERSION = "2026-10-23-email-collector-v3";
  if (window.__linkedInMoreClickerContentLoaded === CONTENT_SCRIPT_VERSION) {
    return;
  }
  window.__linkedInMoreClickerContentLoaded = CONTENT_SCRIPT_VERSION;

  const POST_SELECTOR = [
    "article",
    ".feed-shared-update-v2",
    ".reusable-search__result-container",
    "[data-urn^='urn:li:activity']",
    "[data-urn^='urn:li:share']",
    "[data-id^='urn:li:activity']",
    "[data-id^='urn:li:share']",
    "[data-view-name*='search' i]",
    "[data-finite-scroll-hotkey-item]"
  ].join(",");
  const PROCESSED_ATTRIBUTE = "data-li-more-clicker-processed";
  const MIN_CLICK_DELAY_MS = 300;
  const MAX_CLICK_DELAY_MS = 700;
  const SCAN_INTERVAL_MS = 1400;
  const END_STABLE_CHECKS_REQUIRED = 5;

  const processedButtons = new WeakSet();
  const observedEmails = new Set();
  let running = false;
  let warning = "";
  let completionMessage = "";
  let completionReason = "";
  let stableEndChecks = 0;
  let previousPostCount = 0;
  let previousScrollHeight = 0;
  let previousPostFingerprint = "";
  let loopPromise = null;
  let finalizationPending = false;
  let finalizing = false;
  let finalizationPromise = Promise.resolve();
  let runDate = "";

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function getLocalDate() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
  }

  function isAllowedUrl() {
    return location.hostname === "www.linkedin.com" &&
      /^\/search\/results\/content(?:\/|$)/.test(location.pathname);
  }

  function getStatus() {
    return { running, finalizing, warning, completionMessage };
  }

  function publishStatus() {
    chrome.runtime.sendMessage({
      type: "RUN_STATE",
      state: getStatus()
    }).catch(() => {});
  }

  function normalizeText(value) {
    return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  }

  function isOutsideActionAreas(element) {
    return !element.closest([
      "aside",
      "footer",
      "nav",
      "[role='menu']",
      "[role='menubar']",
      "[aria-label*='social actions' i]",
      "[aria-label*='reaction' i]",
      "[aria-label*='comments' i]",
      "[aria-label*='share' i]"
    ].join(","));
  }

  function isInsidePrimaryContent(element) {
    return Boolean(element.closest("main, [role='main']")) &&
      !element.closest("aside");
  }

  function isValidMoreButton(element) {
    const labels = [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].map(normalizeText);
    return (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") &&
      !processedButtons.has(element) &&
      element.getAttribute(PROCESSED_ATTRIBUTE) !== "true" &&
      labels.some((text) =>
        /^(?:(?:\u2026|\.\.\.)\s*)?(?:see\s+)?more(?:\s*(?:\u2026|\.\.\.))?$/.test(text)
      ) &&
      isVisible(element) &&
      isInsidePrimaryContent(element) &&
      isOutsideActionAreas(element);
  }

  function getPostElements() {
    const posts = [...document.querySelectorAll(POST_SELECTOR)]
      .filter((post) => isInsidePrimaryContent(post) && isOutsideActionAreas(post));
    if (posts.length > 0) {
      return posts;
    }

    return [...document.querySelectorAll("main, [role='main']")]
      .filter(isVisible);
  }

  function getPostFingerprint(posts) {
    return posts.slice(-3).map((post) =>
      post.getAttribute("data-urn") ||
      post.getAttribute("data-id") ||
      normalizeText(post.innerText || post.textContent).slice(-120)
    ).join("|");
  }

  function getReadableText(element) {
    if (typeof element.innerText === "string" && element.innerText.length > 0) {
      return element.innerText;
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("script, style, noscript, [aria-hidden='true']")) {
        continue;
      }
      textNodes.push(node.nodeValue || "");
    }
    return textNodes.join("\n");
  }

  async function captureEmails() {
    const newEmails = new Map();
    const posts = getPostElements();
    for (const post of posts) {
      const text = getReadableText(post);
      for (const email of EmailExtractor.extractEmails(text)) {
        const comparisonKey = email.trim().toLowerCase();
        if (!observedEmails.has(comparisonKey)) {
          newEmails.set(comparisonKey, email.trim());
        }
      }
      for (const link of post.querySelectorAll('a[href^="mailto:"]')) {
        const rawAddress = (link.getAttribute("href") || "")
          .slice("mailto:".length)
          .split("?")[0];
        let emailText;
        try {
          emailText = decodeURIComponent(rawAddress).trim();
        } catch {
          emailText = rawAddress.trim();
        }
        const sanitized = EmailExtractor.sanitizeEmail(emailText);
        const comparisonKey = sanitized?.trim().toLowerCase();
        if (sanitized && comparisonKey && !observedEmails.has(comparisonKey)) {
          newEmails.set(comparisonKey, sanitized);
        }
      }
    }

    if (newEmails.size === 0) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "CAPTURE_EMAILS",
      emails: [...newEmails.values()],
      date: runDate
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || "Could not save captured emails to the project folder.");
    }
    for (const comparisonKey of newEmails.keys()) {
      observedEmails.add(comparisonKey);
    }
  }

  function getVisibleModals() {
    return [...document.querySelectorAll("[role='dialog'], [aria-modal='true']")]
      .filter(isVisible);
  }

  function hasNewVisibleModal(previousModals) {
    const previousSet = new WeakSet(previousModals);
    return getVisibleModals().some((modal) => !previousSet.has(modal));
  }

  function findScrollTarget() {
    const candidates = [
      document.scrollingElement,
      ...document.querySelectorAll("main, [role='main'], .scaffold-finite-scroll, [data-finite-scroll-container]")
    ].filter(Boolean);

    return candidates
      .map((element) => ({
        element,
        overflow: element.scrollHeight - element.clientHeight
      }))
      .filter(({ element, overflow }) => {
        if (overflow <= 100) {
          return false;
        }
        if (element === document.scrollingElement) {
          return true;
        }
        const style = window.getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY);
      })
      .sort((left, right) => right.overflow - left.overflow)[0]?.element ||
      document.scrollingElement;
  }

  function getScrollMetrics(target) {
    const isDocument = target === document.scrollingElement;
    const top = isDocument ? window.scrollY : target.scrollTop;
    const height = isDocument ? document.documentElement.scrollHeight : target.scrollHeight;
    const viewport = isDocument ? window.innerHeight : target.clientHeight;
    return {
      atBottom: top + viewport >= height - 220,
      height,
      viewport
    };
  }

  function scrollDown(target, viewport) {
    const amount = Math.max(500, Math.floor(viewport * 0.75));
    if (target === document.scrollingElement) {
      window.scrollBy({ top: amount, behavior: "smooth" });
    } else {
      target.scrollBy({ top: amount, behavior: "smooth" });
    }
  }

  function stopWithWarning(message) {
    warning = message;
    running = false;
    publishStatus();
    queueFinalization();
  }

  function stop(reason = "") {
    running = false;
    warning = "";
    completionReason = reason;
    publishStatus();
    queueFinalization();
  }

  function queueFinalization() {
    if (finalizationPending) {
      return finalizationPromise;
    }

    finalizationPending = true;
    finalizing = true;
    completionMessage = "";
    publishStatus();
    finalizationPromise = chrome.runtime.sendMessage({
      type: "FINALIZE_COLLECTION",
      date: runDate
    }).then((response) => {
      if (!response || !response.ok) {
        throw new Error(response?.error || "Final email comparison failed.");
      }
      const data = response.data || {};
      completionMessage = [
        warning,
        completionReason,
        `Completed. Compared ${data.comparedMasterEmails || 0} master emails and updated the workbook.`
      ].filter(Boolean).join(" ");
      warning = "";
    }).catch((error) => {
      console.error("Email Collector could not compare emails or update the workbook:", error);
      warning = [warning, `Comparison failed: ${error.message}`].filter(Boolean).join(" ");
    }).finally(() => {
      finalizationPending = false;
      finalizing = false;
      publishStatus();
    });
    return finalizationPromise;
  }

  async function processPage() {
    await captureEmails();
    if (!running) {
      return;
    }

    const button = [...document.querySelectorAll("button, [role='button']")]
      .find(isValidMoreButton);

    if (button) {
      stableEndChecks = 0;
      await delay(randomDelay(MIN_CLICK_DELAY_MS, MAX_CLICK_DELAY_MS));
      if (!running || !isAllowedUrl() || !isValidMoreButton(button)) {
        return;
      }

      const previousUrl = location.href;
      const previousModals = getVisibleModals();
      processedButtons.add(button);
      button.setAttribute(PROCESSED_ATTRIBUTE, "true");
      button.click();
      await delay(500);

      if (location.href !== previousUrl || !isAllowedUrl()) {
        stopWithWarning("Stopped because an expand click changed the page.");
        return;
      }
      if (hasNewVisibleModal(previousModals)) {
        stopWithWarning("Stopped because an expand click opened a dialog.");
        return;
      }
      await captureEmails();
      return;
    }

    const posts = getPostElements();
    const postFingerprint = getPostFingerprint(posts);
    const target = findScrollTarget();
    const metrics = getScrollMetrics(target);
    if (metrics.atBottom &&
        posts.length === previousPostCount &&
        metrics.height === previousScrollHeight &&
        postFingerprint === previousPostFingerprint) {
      stableEndChecks += 1;
    } else {
      stableEndChecks = 0;
    }

    previousPostCount = posts.length;
    previousScrollHeight = metrics.height;
    previousPostFingerprint = postFingerprint;
    if (stableEndChecks >= END_STABLE_CHECKS_REQUIRED) {
      stop("Reached the end of the results. Collection stopped automatically.");
      return;
    }

    scrollDown(target, metrics.viewport);
    await delay(SCAN_INTERVAL_MS);
  }

  async function runLoop() {
    while (running) {
      if (!isAllowedUrl()) {
        stopWithWarning("Stopped because the page left LinkedIn content search results.");
        break;
      }

      try {
        await processPage();
      } catch (error) {
        stopWithWarning(`Collection stopped: ${error.message}`);
        break;
      }
    }
  }

  async function start() {
    if (!isAllowedUrl()) {
      stopWithWarning("Open a LinkedIn content search results page first.");
      return;
    }

    if (finalizationPending) {
      await finalizationPromise;
    }

    runDate = getLocalDate();
    warning = "";
    completionMessage = "";
    completionReason = "";
    stableEndChecks = 0;
    previousPostCount = -1;
    previousScrollHeight = -1;
    previousPostFingerprint = "";
    running = true;
    publishStatus();
    if (!loopPromise) {
      loopPromise = runLoop().finally(() => {
        loopPromise = null;
        if (running) {
          start();
        }
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "START") {
      start();
      sendResponse(getStatus());
      return false;
    }
    if (message.type === "STOP") {
      stop();
      sendResponse(getStatus());
      return false;
    }
    if (message.type === "GET_STATUS") {
      sendResponse(getStatus());
      return false;
    }
    return false;
  });

  publishStatus();
})();

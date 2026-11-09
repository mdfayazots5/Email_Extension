const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusElement = document.getElementById("status");

const LINKEDIN_SEARCH_RESULTS_URL =
  /^https:\/\/www\.linkedin\.com\/search\/results\/content(?:\/|\?|#|$)/;

let activeTabId = null;
let refreshInProgress = false;

function render(state = {}) {
  const isRunning = Boolean(state.running);
  const isFinalizing = Boolean(state.finalizing);
  startButton.disabled = !activeTabId || isRunning || isFinalizing;
  stopButton.disabled = !activeTabId || !isRunning;
  const message = isFinalizing
    ? "Updating the workbook. Keep Excel closed until finished."
    : state.warning || state.completionMessage ||
      (isRunning ? "Collecting emails... Stop to update the workbook." : "");
  statusElement.textContent = message;
  statusElement.hidden = !message;
  statusElement.classList.toggle("error", Boolean(state.warning));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

function isSupportedTab(tab) {
  return Boolean(tab && Number.isInteger(tab.id) &&
    LINKEDIN_SEARCH_RESULTS_URL.test(tab.url || ""));
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["email-extractor.js", "content.js"]
  });
}

async function messageActiveTab(message) {
  const tab = await getActiveTab();
  if (!isSupportedTab(tab)) {
    activeTabId = null;
    render();
    return null;
  }

  activeTabId = tab.id;
  let response = await sendTabMessage(tab.id, message);
  if (!response) {
    await ensureContentScript(tab.id);
    response = await sendTabMessage(tab.id, message);
  }
  if (!response) {
    throw new Error("Could not communicate with the LinkedIn page.");
  }
  render(response);
  return response;
}

async function refresh() {
  if (refreshInProgress) {
    return;
  }
  refreshInProgress = true;
  try {
    const tab = await getActiveTab();
    if (!isSupportedTab(tab)) {
      activeTabId = null;
      render();
      return;
    }
    activeTabId = tab.id;
    await messageActiveTab({ type: "GET_STATUS" });
  } catch (error) {
    console.error("Email Collector status check failed:", error);
    startButton.disabled = true;
    stopButton.disabled = true;
  } finally {
    refreshInProgress = false;
  }
}

startButton.addEventListener("click", async () => {
  try {
    await messageActiveTab({ type: "START" });
  } catch (error) {
    console.error("Email Collector could not start:", error);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await messageActiveTab({ type: "STOP" });
  } catch (error) {
    console.error("Email Collector could not stop:", error);
  }
});

refresh();
setInterval(refresh, 1500);

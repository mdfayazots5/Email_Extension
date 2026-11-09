let nativeRequestQueue = Promise.resolve();

function requestNativeHost(message) {
  const request = nativeRequestQueue.then(() => new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connectNative("com.jobsearch.emailcollector");
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        port.disconnect();
        reject(new Error("The local email workbook helper did not respond."));
      }
    }, 30000);

    port.onMessage.addListener((response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      port.disconnect();
      if (!response || response.ok !== true) {
        reject(new Error(response?.error || "The local email workbook helper failed."));
        return;
      }
      resolve(response.data);
    });

    port.onDisconnect.addListener(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(chrome.runtime.lastError?.message ||
        "The local email workbook helper disconnected."));
    });

    port.postMessage(message);
  }));

  nativeRequestQueue = request.catch(() => {});
  return request;
}

function getDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }

  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  let nativeMessage;
  if (message.type === "CAPTURE_EMAILS" && Array.isArray(message.emails)) {
    nativeMessage = {
      type: "CAPTURE_EMAILS",
      emails: message.emails,
      date: getDate(message.date)
    };
  } else if (message.type === "FINALIZE_COLLECTION") {
    nativeMessage = { type: "FINALIZE", date: getDate(message.date) };
  } else if (message.type === "RUN_STATE") {
    chrome.storage.local.set({ runState: message.state });
    sendResponse({ ok: true });
    return false;
  } else {
    return false;
  }

  requestNativeHost(nativeMessage).then((data) => {
    sendResponse({ ok: true, data });
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  ACTIVITY_LOGS_KEY,
  activityLogFileName,
  logCountries,
  deleteActivityLog,
  formatDayReport,
  isActivityLogEnabled,
  LOG_RETENTION_DAYS,
  readActivityLogs,
  setActivityLogEnabled,
  summarizeDay,
  type DayActivityLog
} from "../api/activity-log";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Settings → Activity log: daily LinkedIn activity, one log per day, with copy and download. */
export function ActivityLogControls() {
  const [enabled, setEnabled] = useState(true);
  const [logs, setLogs] = useState<DayActivityLog[]>([]);
  const [viewing, setViewing] = useState<DayActivityLog | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const [isOn, entries] = await Promise.all([isActivityLogEnabled(), readActivityLogs()]);
      setEnabled(isOn);
      setLogs(entries);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load the activity log.");
    }
  }, []);

  useEffect(() => {
    void load();
    // Keep today's numbers live while a run is going.
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[ACTIVITY_LOGS_KEY]) void load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [load]);

  const toggle = async (value: boolean) => {
    setMessage("");
    try {
      await setActivityLogEnabled(value);
      setEnabled(value);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the setting.");
    }
  };

  const copy = async (log: DayActivityLog) => {
    try {
      await navigator.clipboard.writeText(formatDayReport(log));
      setMessage(`Log for ${formatDay(log.day)} copied. Paste it wherever you need it.`);
    } catch {
      setViewing(log);
      setMessage("Could not copy automatically. Select the text in the window and copy it.");
    }
  };

  const remove = async (day?: string) => {
    if (!window.confirm(day ? `Delete the log for ${formatDay(day)}?` : "Delete every saved activity log?")) return;
    await deleteActivityLog(day);
    setMessage(day ? "Log deleted." : "All logs deleted.");
    await load();
  };

  return (
    <>
      <label className="sx-switch">
        <span>
          <strong>Record a daily activity log</strong>
          <small>
            Each day starts a new, empty log at the first activity. It records runs, searches, LinkedIn search page loads,
            scrolls, posts, pauses, stops and any LinkedIn warning, with times. The last {LOG_RETENTION_DAYS} days are kept in this
            Chrome profile. Emails, post text, names and links are never stored.
          </small>
        </span>
        <span className="toggle-field"><input type="checkbox" checked={enabled} onChange={(event) => void toggle(event.target.checked)} /><span /></span>
      </label>
      {message && <p className="log-feedback" role="status">{message}</p>}
      {logs.length ? (
        <ul className="sx-history">
          {logs.map((log) => {
            const summary = summarizeDay(log);
            const warned = log.counters.securityNotices > 0;
            return (
              <li key={log.day}>
                <span>
                  <strong>{formatDay(log.day)}{warned && <span className="sx-flag" title="LinkedIn showed a warning this day" style={{ marginLeft: 8 }}>!</span>}</strong>
                  <small>
                    {logCountries(log).map((country) => country.name).join(", ") || "No searches"}{" · "}
                    {log.counters.searchesOpened} searches · {log.counters.pageLoads} search page loads · {log.counters.scrolls} scrolls · {log.counters.postsScanned} posts
                    {" · "}busiest hour {summary.busiestHourSearches} searches
                    {warned && summary.firstWarningAt ? ` · warning at ${new Date(summary.firstWarningAt).toLocaleTimeString()}` : ""}
                  </small>
                </span>
                <span className="button-row">
                  <button className="button button--secondary button--small" type="button" onClick={() => setViewing(log)}>View</button>
                  <button className="button button--secondary button--small" type="button" onClick={() => void copy(log)}>Copy</button>
                  <button className="button button--secondary button--small" type="button" onClick={() => download(activityLogFileName(log), formatDayReport(log))}>Download</button>
                  <button className="button button--secondary button--small" type="button" onClick={() => void remove(log.day)}>Delete</button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-state">{enabled ? "No activity recorded yet. Today's log starts with your next run." : "The activity log is off."}</p>
      )}
      {logs.length > 1 && (
        <div className="button-row"><button className="button button--secondary button--small" type="button" onClick={() => void remove()}>Delete all logs</button></div>
      )}
      {viewing && (
        <Modal title={`Activity log · ${formatDay(viewing.day)}`} onClose={() => setViewing(null)}>
          <div className="modal-body">
            <textarea className="import-textarea connection-log-output" aria-label="Activity log" readOnly rows={18} value={formatDayReport(viewing)} />
            <div className="button-row">
              <button className="button button--primary" type="button" onClick={() => void copy(viewing)}>Copy</button>
              <button className="button button--secondary" type="button" onClick={() => download(activityLogFileName(viewing), formatDayReport(viewing))}>Download</button>
              <button className="button button--secondary" type="button" onClick={() => setViewing(null)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

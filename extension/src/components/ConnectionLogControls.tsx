import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { readConnectionLogs, type ConnectionLogEntry } from "../api/connection-logs";

const ENABLED_KEY = "connectionLogsEnabled";

export function ConnectionLogControls() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ConnectionLogEntry[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void chrome.storage.local.get(ENABLED_KEY).then((state) => {
      setEnabled(state[ENABLED_KEY] === true);
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Could not load log setting.");
    });
  }, []);

  const toggle = async (value: boolean) => {
    setMessage("");
    try {
      await chrome.storage.local.set({ [ENABLED_KEY]: value });
      setEnabled(value);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save log setting.");
    }
  };

  const showLogs = async () => {
    setMessage("");
    try {
      setEntries(await readConnectionLogs());
      setOpen(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read connection logs.");
    }
  };

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
      setMessage("Connection logs copied.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not copy logs. Select and copy the text below.");
    }
  };

  return (
    <>
      <div className="connection-log-controls">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => void toggle(event.target.checked)}
          />
          <span>Logs</span>
          <small>Save connection diagnostic logs in this Chrome profile.</small>
        </label>
        <button className="button button--secondary" type="button" onClick={() => void showLogs()}>
          View Logs
        </button>
      </div>
      {message && <p className="log-feedback" role="status">{message}</p>}
      {open && (
        <Modal title="Connection Logs" onClose={() => setOpen(false)}>
          <div className="modal-body">
            <p className="muted">Logs are stored in this Chrome profile. Tokens and captured email contents are not recorded.</p>
            {entries.length ? (
              <textarea
                className="import-textarea connection-log-output"
                aria-label="Connection log entries"
                readOnly
                rows={14}
                value={JSON.stringify(entries, null, 2)}
              />
            ) : (
              <p className="empty-state">No connection logs yet. Turn Logs on, then test the connection.</p>
            )}
            <div className="button-row">
              <button className="button button--primary" type="button" disabled={!entries.length} onClick={() => void copyLogs()}>
                Copy logs
              </button>
              <button className="button button--secondary" type="button" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

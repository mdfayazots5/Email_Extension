import { useCallback, useEffect, useState } from "react";
import { ApiError, HOST_NOT_INSTALLED_MESSAGE, api } from "../api/client";
import { recordConnectionLog } from "../api/connection-logs";
import { ConnectionLogControls } from "./ConnectionLogControls";

type SetupScreenProps = {
  onConnected: () => void;
};

/**
 * Shown only while the extension is not connected. It connects by itself: the
 * native host starts the local service and supplies the token, so there is
 * nothing to paste or run. Instructions appear only if the one-time install is missing.
 */
export function SetupScreen({ onConnected }: SetupScreenProps) {
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState(true);

  const connect = useCallback(async () => {
    setConnecting(true);
    setMessage("");
    let connected = false;
    try {
      await recordConnectionLog("setup_test_clicked");
      await api.health();
      connected = true;
      onConnected();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "Could not connect to the tracker service.");
    } finally {
      await recordConnectionLog("setup_test_finished", { success: connected });
      setConnecting(false);
    }
  }, [onConnected]);

  useEffect(() => {
    void connect();
    // Connect once when the screen opens; Retry handles later attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsInstall = message === HOST_NOT_INSTALLED_MESSAGE;

  return (
    <section className="setup-card" aria-labelledby="setup-title">
      <h2 id="setup-title">{connecting ? "Starting your tracker…" : needsInstall ? "One-time setup" : "Could not connect"}</h2>
      {connecting && <p className="muted">Starting the tracker service. This takes a few seconds the first time after Windows starts.</p>}
      {!connecting && needsInstall && (
        <ol className="setup-steps">
          <li><strong>Run the installer once</strong><span>In the project folder, right-click <code>native-host\install.ps1</code> and choose <strong>Run with PowerShell</strong>.</span></li>
          <li><strong>Restart Chrome</strong><span>Close every Chrome window and open Chrome again. Every Chrome profile on this PC then connects by itself.</span></li>
        </ol>
      )}
      {!connecting && message && !needsInstall && <p className="feedback feedback--error" role="status">{message}</p>}
      {!connecting && (
        <div className="button-row setup-submit">
          <button className="button button--primary" type="button" onClick={() => void connect()}>Retry</button>
        </div>
      )}
      <ConnectionLogControls />
    </section>
  );
}

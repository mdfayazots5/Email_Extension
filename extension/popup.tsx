import React from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

function Popup() {
  const openView = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("index.html?page=view") });
    window.close();
  };

  return (
    <main className="popup">
      <div className="popup-controls">
        <button type="button" className="popup-view" onClick={openView}>View</button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);

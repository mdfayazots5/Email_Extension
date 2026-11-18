import React from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

function Popup() {
  const openView = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("index.html?page=view") });
    window.close();
  };

  const openGuide = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("index.html?page=view&guide=welcome") });
    window.close();
  };

  return (
    <main className="popup">
      <div className="popup-controls">
        <button type="button" className="popup-view" onClick={openView}>View</button>
      </div>
      <button type="button" className="popup-guide" onClick={openGuide}>How to use</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);

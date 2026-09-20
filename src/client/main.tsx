import React from "react";
import ReactDOM from "react-dom/client";
import { AppRouter } from "./router.js";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppRouter />
    </React.StrictMode>,
  );
}

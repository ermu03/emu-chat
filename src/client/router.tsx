import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./app.js";

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<AppShell />} />
      </Routes>
    </BrowserRouter>
  );
}

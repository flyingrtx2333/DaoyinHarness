import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./cloud.css";

const root = document.getElementById("root");
if (!root) throw new Error("Workbench root missing");
createRoot(root).render(<App />);

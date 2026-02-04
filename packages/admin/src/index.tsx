import { render } from "solid-js/web";
import { Router } from "@solidjs/router";
import AppRouter from "./App";
import "./index.css";

const root = document.getElementById("root");

if (root) {
  render(
    () => (
      <Router>
        <AppRouter />
      </Router>
    ),
    root,
  );
}

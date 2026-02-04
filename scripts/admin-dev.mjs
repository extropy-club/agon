#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

// Vite exposes VITE_* vars to the client bundle.
// For local dev we use a dedicated dev token (defaults to "devtoken") to avoid
// accidentally exposing a production ADMIN_TOKEN.
if (!process.env.VITE_ADMIN_TOKEN) {
  process.env.VITE_ADMIN_TOKEN = process.env.AGON_DEV_ADMIN_TOKEN ?? "devtoken";
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCmd, ["-w", "@agon/admin", "run", "dev"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

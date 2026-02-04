#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const candidateCaFiles = [
  process.env.SSL_CERT_FILE,
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem", // common on macOS
].filter(Boolean);

const findCaFile = () => {
  for (const p of candidateCaFiles) {
    if (typeof p === "string" && p.length > 0 && existsSync(p)) return p;
  }
  return null;
};

const current = process.env.SSL_CERT_FILE;
const currentOk = typeof current === "string" && current.length > 0 && existsSync(current);
const caFile = findCaFile();

// Workerd on some systems (notably Nix) won't trust system CAs unless SSL_CERT_FILE is set.
if (!currentOk && caFile) {
  process.env.SSL_CERT_FILE = caFile;
}

// Bootstrap .dev.vars from the current environment (vault) if the file doesn't exist.
// This avoids passing secrets on the command line via `--var`.
if (!existsSync(".dev.vars")) {
  const quote = (s) =>
    `"${String(s)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\r", "")
      .replaceAll("\n", "")}"`;

  const devAdminToken = process.env.AGON_DEV_ADMIN_TOKEN ?? "devtoken";

  const keys = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_PUBLIC_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_TITLE",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
  ];

  const lines = [`ADMIN_TOKEN=${quote(devAdminToken)}`];

  for (const key of keys) {
    const val = process.env[key];
    if (typeof val === "string" && val.length > 0) {
      lines.push(`${key}=${quote(val)}`);
    }
  }

  writeFileSync(".dev.vars", `${lines.join("\n")}\n`, { mode: 0o600 });
}

const extraArgs = process.argv.slice(2);

const wranglerCmd = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const child = spawn(wranglerCmd, ["dev", ...extraArgs], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

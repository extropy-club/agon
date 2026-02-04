#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Ensure `.dev.vars` matches the current environment (vault).
//
// We keep secrets out of argv (no `--var ...`) and avoid quoting, because on some
// setups quotes can leak into the final env value (breaking Discord/OpenRouter auth).
{
  const stripQuotes = (s) =>
    String(s)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");

  const sanitize = (s) => stripQuotes(String(s).replaceAll("\r", "").replaceAll("\n", "").trim());

  const keys = [
    "ADMIN_TOKEN",
    "DISCORD_BOT_TOKEN",
    "DISCORD_PUBLIC_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_TITLE",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
  ];

  // Start from existing .dev.vars so we don't delete values when the vault isn't exporting them.
  const existing = new Map();
  if (existsSync(".dev.vars")) {
    const txt = readFileSync(".dev.vars", "utf8");
    for (const rawLine of txt.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1);
      existing.set(k, sanitize(v));
    }
  }

  const devAdminToken = sanitize(
    process.env.AGON_DEV_ADMIN_TOKEN ?? existing.get("ADMIN_TOKEN") ?? "devtoken",
  );
  existing.set("ADMIN_TOKEN", devAdminToken);

  for (const key of keys) {
    if (key === "ADMIN_TOKEN") continue;
    const envVal = process.env[key];
    if (typeof envVal === "string" && envVal.length > 0) {
      existing.set(key, sanitize(envVal));
    }
  }

  const lines = [];
  for (const [k, v] of existing.entries()) {
    lines.push(`${k}=${v}`);
  }

  // Always write (0600) so changes in the vault env take effect immediately.
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

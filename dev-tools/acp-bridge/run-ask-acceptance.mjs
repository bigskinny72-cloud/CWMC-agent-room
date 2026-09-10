#!/usr/bin/env node
/**
 * Read-only Ask-mode acceptance test for the local ACP bridge.
 * Does not modify the repo, databases, env, MCP, or networking.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const bridgePath = path.join(__dirname, "bridge.mjs");

const PROMPT =
  "Report the current Git branch and HEAD commit only. Do not modify anything.";

const child = spawn(
  process.execPath,
  [
    bridgePath,
    "--cwd",
    repoRoot,
    "--mode",
    "ask",
    "--prompt",
    PROMPT,
  ],
  {
    stdio: "inherit",
    cwd: repoRoot,
    env: process.env,
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[run-ask-acceptance] killed by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

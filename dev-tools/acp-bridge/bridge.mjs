#!/usr/bin/env node
/**
 * Local-development ACP bridge only.
 * Spawns `agent acp` and speaks newline-delimited JSON-RPC over stdio.
 * Does not modify Agent Room runtime, SQLite, env, MCP, or networking.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import process from "node:process";

function usage(exitCode = 1) {
  console.error(`Usage: node bridge.mjs --cwd <dir> --mode <ask|plan|agent> --prompt "<text>"

Options:
  --cwd <dir>       Working directory for the agent session (required)
  --mode <mode>     Session mode: ask | plan | agent (default: ask)
  --prompt <text>   Prompt text (required)
  --agent <path>    Path/command for Cursor agent binary (default: agent)
  --timeout-ms <n>  Kill the session after N ms (default: 180000)
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    cwd: null,
    mode: "ask",
    prompt: null,
    agent: "agent",
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${a}`);
      usage(1);
    }
  }
  if (!out.cwd || !out.prompt) usage(1);
  if (!["ask", "plan", "agent"].includes(out.mode)) {
    console.error(`Invalid --mode: ${out.mode}`);
    usage(1);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    console.error(`Invalid --timeout-ms: ${out.timeoutMs}`);
    usage(1);
  }
  out.cwd = path.resolve(out.cwd);
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** Quote one argument for cmd.exe when building a /c command line. */
function quoteForCmd(value) {
  const s = String(value);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Spawn Cursor Agent without shell:true.
 * Windows .cmd/.bat (including absolute paths with spaces) must go through
 * ComSpec with a properly quoted /c command line — never Node shell concatenation.
 */
function spawnCursorAgent(command, agentArgs, options) {
  if (process.platform !== "win32") {
    return spawn(command, agentArgs, { ...options, shell: false });
  }

  const ext = path.extname(command).toLowerCase();
  const useCmdWrapper = ext === ".cmd" || ext === ".bat" || ext === "";
  if (!useCmdWrapper) {
    return spawn(command, agentArgs, { ...options, shell: false });
  }

  const comSpec =
    process.env.ComSpec ||
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  // Build an inner command line, then wrap in an extra pair of quotes.
  // cmd.exe /S strips one outer quote pair; without the wrap, a quoted path
  // with spaces loses its quotes and splits at the first space.
  const commandLine = [quoteForCmd(command), ...agentArgs.map(quoteForCmd)].join(" ");
  const wrapped = `"${commandLine}"`;
  return spawn(comSpec, ["/d", "/s", "/c", wrapped], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

const agent = spawnCursorAgent(args.agent, ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: args.cwd,
  env: process.env,
});

let nextId = 1;
const pending = new Map();
let agentMessage = "";
let authRequiredReported = false;
let shuttingDown = false;

function send(method, params) {
  const id = nextId++;
  agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

function respond(id, result) {
  agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function isAuthRequiredPayload(payload) {
  const text = JSON.stringify(payload ?? {}).toLowerCase();
  return (
    text.includes("authenticat") ||
    text.includes("not logged") ||
    text.includes("login required") ||
    text.includes("cursor_login") ||
    text.includes("unauthorized")
  );
}

function reportAuthRequired(detail) {
  if (authRequiredReported) return;
  authRequiredReported = true;
  console.error("[acp-bridge] authentication-required");
  if (detail) console.error(typeof detail === "string" ? detail : JSON.stringify(detail));
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    agent.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    agent.kill();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

agent.stderr.on("data", (buf) => {
  const text = buf.toString();
  process.stderr.write(text);
  if (isAuthRequiredPayload(text)) reportAuthRequired(text.trim());
});

agent.on("error", (err) => {
  console.error(`[acp-bridge] failed to spawn agent: ${err.message}`);
  shutdown(1);
});

agent.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[acp-bridge] agent exited code=${code} signal=${signal}`);
  shutdown(code && code !== 0 ? code : 1);
});

const rl = readline.createInterface({ input: agent.stdout });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[acp-bridge] non-JSON stdout: ${line}`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(msg, "id") && (msg.result !== undefined || msg.error)) {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) {
      if (isAuthRequiredPayload(msg.error)) reportAuthRequired(msg.error);
      waiter.reject(msg.error);
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "session/update") {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      agentMessage += update.content.text;
      process.stdout.write(update.content.text);
    }
    return;
  }

  if (msg.method === "session/request_permission") {
    // Conservative default: never auto-bypass. No --yolo / allow-always.
    respond(msg.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
    return;
  }

  if (msg.method === "cursor/ask_question") {
    respond(msg.id, { outcome: { outcome: "cancelled" } });
    return;
  }

  if (msg.method === "cursor/create_plan") {
    respond(msg.id, { outcome: { outcome: "cancelled" } });
    return;
  }

  // Other notifications (cursor/update_todos, cursor/task, …) are fire-and-forget.
});

const timeout = setTimeout(() => {
  console.error(`[acp-bridge] timeout after ${args.timeoutMs}ms`);
  shutdown(1);
}, args.timeoutMs);

async function main() {
  const initResult = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "cwmc-local-acp-bridge", version: "0.1.0" },
  });

  // Do not proactively call authenticate / cursor_login.
  // Only surface auth-required when the agent says so.
  const authMethods = initResult?.authMethods ?? initResult?.authenticationMethods;
  if (Array.isArray(authMethods) && authMethods.length > 0) {
    // Capability advertisement alone is not a hard requirement; proceed and
    // only fail if a later RPC explicitly demands authentication.
  }

  let sessionId;
  try {
    const created = await send("session/new", {
      cwd: args.cwd,
      mcpServers: [],
    });
    sessionId = created.sessionId;
  } catch (err) {
    if (isAuthRequiredPayload(err)) {
      reportAuthRequired(err);
      clearTimeout(timeout);
      shutdown(2);
      return;
    }
    throw err;
  }

  try {
    await send("session/set_mode", { sessionId, modeId: args.mode });
  } catch (err) {
    if (isAuthRequiredPayload(err)) {
      reportAuthRequired(err);
      clearTimeout(timeout);
      shutdown(2);
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: args.prompt }],
    });
  } catch (err) {
    if (isAuthRequiredPayload(err)) {
      reportAuthRequired(err);
      clearTimeout(timeout);
      shutdown(2);
      return;
    }
    throw err;
  }

  process.stdout.write("\n");
  console.error(`[acp-bridge] stopReason=${result?.stopReason ?? "unknown"}`);
  if (!agentMessage.trim()) {
    console.error("[acp-bridge] warning: no agent_message_chunk text received");
  }

  clearTimeout(timeout);
  shutdown(0);
}

main().catch((err) => {
  console.error("[acp-bridge] fatal:", err?.message ?? err);
  if (isAuthRequiredPayload(err)) reportAuthRequired(err);
  clearTimeout(timeout);
  shutdown(1);
});

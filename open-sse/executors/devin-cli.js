/**
 * DevinCliExecutor — routes completions through the official Devin CLI binary
 * via the Agent Client Protocol (ACP) JSON-RPC 2.0 over stdio.
 *
 * Protocol flow:
 *   1. Spawn `devin acp` (default agent = full built-in tools: fs/shell/search).
 *      Set CLI_DEVIN_AGENT_TYPE=summarizer for a tool-less, text-only mode.
 *   2. Send: initialize → session/new (with model + cwd + mcpServers) → session/prompt.
 *   3. Receive: session/update notifications (agent_message_chunk = reply text,
 *      tool_call/tool_call_update = built-in tool invocations, surfaced as text).
 *      When devin calls a client-tool from the exposed MCP ("Calling mcp_X from
 *      clientTools"), it is bridged to an OpenAI tool_use and the turn ends.
 *   4. Emit deltas as OpenAI-compatible SSE chunks.
 *   5. Kill subprocess on _cognition.ai/agent_stopped or error.
 *
 * Auth: noAuth — the subprocess inherits the parent env and uses credentials
 * stored by `devin auth login` (~/.local/share/devin/credentials.toml).
 *
 * Binary discovery: CLI_DEVIN_BIN env → PATH lookup → platform installer paths.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.js";

// ─── Binary discovery ────────────────────────────────────────────────────────

function resolveDevinBin() {
  // 1. Explicit override
  const envBin = process.env.CLI_DEVIN_BIN?.trim();
  if (envBin) return envBin;

  const isWin = process.platform === "win32";
  const home = os.homedir();

  // 2. Known installer / package-manager locations. spawn uses shell:false on
  //    macOS/Linux, so process.env.PATH alone may miss ~/.local/bin, Homebrew,
  //    Scoop, etc. when the server runs detached (tray/daemon/launchd) without
  //    a login shell — probe these explicitly before falling back to PATH.
  const candidates = isWin
    ? [
      // Official installer: %LOCALAPPDATA%\devin\cli\bin\devin.exe
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "devin", "cli", "bin", "devin.exe"),
      path.join(home, ".local", "bin", "devin.exe"),
      path.join(home, "scoop", "shims", "devin.exe"),
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "devin", "devin.exe"),
    ]
    : [
      path.join(home, ".local", "share", "devin", "bin", "devin"),
      path.join(home, ".devin", "bin", "devin"),
      path.join(home, ".local", "bin", "devin"), // pipx / user install
      "/opt/homebrew/bin/devin",                  // Homebrew (Apple Silicon)
      "/usr/local/bin/devin",                     // Homebrew (Intel) / manual
      "/usr/bin/devin",
    ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. Fallback — rely on process.env.PATH
  return isWin ? "devin.exe" : "devin";
}

// ─── ACP JSON-RPC helper ────────────────────────────────────────────────────

function rpc(method, params, id) {
  const msg = { jsonrpc: "2.0", method, params };
  if (id !== undefined) msg.id = id;
  return JSON.stringify(msg) + "\n";
}

// ─── Client-tools → MCP bridge ───────────────────────────────────────────────
// devin only invokes built-in + MCP tools, not OpenAI function-calling schemas.
// body.tools are exposed as a stdio MCP server "clientTools" so devin can call
// them. When devin calls one, we emit OpenAI tool_use and end the turn; the
// client executes and returns tool_result on the next request. That next request
// re-spawns with the full history (including tool_calls + tool results) and
// seeds the MCP server with those results so a re-call gets the real data.
// Tool schemas via DEVIN_MCP_TOOLS; prior results via DEVIN_MCP_RESULTS.

const CLIENT_TOOLS_MCP_SCRIPT = `
import readline from "node:readline";
const TOOLS = JSON.parse(process.env.DEVIN_MCP_TOOLS || "[]");
const RESULTS = JSON.parse(process.env.DEVIN_MCP_RESULTS || "{}");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clientTools", version: "1.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  } else if (m.method === "tools/call") {
    const name = m.params?.name || "";
    const seeded = RESULTS[name];
    const text = seeded !== undefined
      ? String(seeded)
      : "(awaiting client tool_result)";
    process.stderr.write("[client-tools] tool_call name=" + name + " seeded=" + (seeded !== undefined) + "\\n");
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
  }
});
`.trimStart();

function ensureClientToolsScript() {
  const scriptPath = path.join(os.tmpdir(), "9router-devin-client-tools.mjs");
  // Always rewrite so script upgrades land without a process restart.
  fs.writeFileSync(scriptPath, CLIENT_TOOLS_MCP_SCRIPT);
  return scriptPath;
}

// Map OpenAI tools ([{type:"function",function:{name,description,parameters}}])
// to MCP tool declarations ([{name,description,inputSchema}]).
// devin only discovers MCP tools whose name carries the `mcp_` prefix, so we
// add it here and strip it back when bridging the call to the client.
const MCP_TOOL_PREFIX = "mcp_";
function toMcpToolName(name) {
  return name.startsWith(MCP_TOOL_PREFIX) ? name : MCP_TOOL_PREFIX + name;
}
function fromMcpToolName(name) {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function buildClientToolsMcp(tools, resultMap) {
  const mcpTools = [];
  for (const t of tools) {
    if (!t) continue;
    const f = t.function || t;
    if (!f?.name) continue;
    mcpTools.push({
      name: toMcpToolName(f.name),
      description: f.description || "",
      inputSchema: f.parameters || f.input_schema || { type: "object", properties: {} },
    });
  }
  if (!mcpTools.length) return null;
  const env = { DEVIN_MCP_TOOLS: JSON.stringify(mcpTools) };
  if (resultMap && Object.keys(resultMap).length) {
    env.DEVIN_MCP_RESULTS = JSON.stringify(resultMap);
  }
  return {
    command: process.execPath,
    args: [ensureClientToolsScript()],
    env,
  };
}

// Extract tool_result content keyed by MCP tool name (mcp_<original>).
// Walks messages: assistant.tool_calls id→name, role=tool tool_call_id→content.
function extractClientToolResults(messages) {
  const idToMcpName = new Map();
  const results = {};
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name || tc?.name;
        if (tc?.id && name) idToMcpName.set(tc.id, toMcpToolName(name));
      }
    }
    // Claude-style tool_use blocks in content
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_use" && b.id && b.name) {
          idToMcpName.set(b.id, toMcpToolName(b.name));
        }
      }
    }
    if (m?.role === "tool" && m.tool_call_id) {
      const mcpName = idToMcpName.get(m.tool_call_id);
      if (mcpName) {
        results[mcpName] =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      }
    }
    // Claude-style tool_result blocks in user content
    if (m?.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_result" && b.tool_use_id) {
          const mcpName = idToMcpName.get(b.tool_use_id);
          if (mcpName) {
            const c = b.content;
            results[mcpName] =
              typeof c === "string" ? c : JSON.stringify(c ?? "");
          }
        }
      }
    }
  }
  return results;
}

// Resolve workspace cwd from client request (Codex/CLI env context, body fields).
// Prefer an absolute existing path so agent file tools hit the user's project
// instead of os.tmpdir() (which made relative create/delete inconsistent).
function resolveWorkspaceCwd(body) {
  const candidates = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) candidates.push(v.trim());
  };
  push(body?.cwd);
  push(body?.working_directory);
  push(body?.workdir);
  push(body?.workspace);
  push(body?.metadata?.cwd);
  push(body?.metadata?.working_directory);

  const scanText = (text) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/gi)) push(m[1]);
  };
  const scanMessages = (msgs) => {
    if (!Array.isArray(msgs)) return;
    for (const msg of msgs) {
      if (!msg) continue;
      if (typeof msg.content === "string") scanText(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "string") scanText(p);
          else if (p && typeof p === "object") {
            scanText(p.text);
            scanText(p.input_text);
            scanText(p.content);
          }
        }
      }
      // Responses API input items
      if (typeof msg === "string") scanText(msg);
      if (msg.type === "message" && Array.isArray(msg.content)) {
        for (const p of msg.content) scanText(p?.text || p?.input_text);
      }
    }
  };
  scanMessages(body?.messages);
  scanMessages(body?.input);

  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) && fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return os.tmpdir();
}

// ─── Multi-turn message → single prompt builder ─────────────────────────────

function buildPromptText(messages) {
  // Inline the whole conversation so the model has full context, including
  // prior tool_calls / tool_results so it can continue after a client round-trip.
  const lines = [];
  for (const m of messages) {
    const role = String(m.role || "user");
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text") text += String(p.text || "");
        else if (p.type === "tool_use") {
          text += `\n[Tool call ${p.name} id=${p.id}]\n${JSON.stringify(p.input ?? {})}\n`;
        } else if (p.type === "tool_result") {
          const c =
            typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
          text += `\n[Tool result id=${p.tool_use_id}]\n${c}\n`;
        }
      }
    }
    // OpenAI tool_calls on assistant messages
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = m.tool_calls.map((tc) => {
        const name = tc.function?.name || tc.name || "tool";
        const args = tc.function?.arguments ?? tc.arguments ?? {};
        const argStr = typeof args === "string" ? args : JSON.stringify(args);
        return `[Tool call ${name} id=${tc.id}]\n${argStr}`;
      });
      text = [text, ...parts].filter(Boolean).join("\n\n");
    }
    // OpenAI role=tool messages
    if (role === "tool") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      text = `[Tool result id=${m.tool_call_id || ""}]\n${c}`;
    }
    if (!text.trim()) continue;
    if (role === "system") {
      lines.push(`[System]\n${text}`);
    } else if (role === "assistant") {
      lines.push(`[Assistant]\n${text}`);
    } else if (role === "tool") {
      lines.push(`[Tool]\n${text}`);
    } else {
      lines.push(`[User]\n${text}`);
    }
  }
  return lines.join("\n\n") || "(empty)";
}

// ─── ACP process pool ─────────────────────────────────────────────────────────
// devin reads its MCP server config (XDG_CONFIG_HOME/devin/config.json) once at
// process boot — the session/new mcpServers param is ignored — so a warm process
// can only serve the tool-set it spawned with. The pool is keyed by a signature
// of that boot config (agent type + mcpServers + cwd); identical requests reuse
// the process and save ~1.5s of spawn+initialize churn per call. Seeded
// DEVIN_MCP_RESULTS are per-request data and are excluded from pooled configs
// (results still travel inlined in the prompt text).
const acpPool = new Map(); // sig → proc[]
let acpPoolSize = 0;
const ACP_POOL_MAX = Math.max(
  1,
  parseInt(process.env.CLI_DEVIN_POOL_MAX || "4", 10) || 4
);

function acpSig(agentType, mcpServers, cwd) {
  return JSON.stringify({ agentType: agentType || "", mcp: mcpServers || {}, cwd });
}

function spawnAcpProc(devinBin, acpArgs, env, cwd, sig, log) {
  const child = spawn(devinBin, acpArgs, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const proc = {
    child,
    sig,
    busy: true,
    dead: false,
    pending: new Map(),
    buf: "",
    handler: null,
    idCounter: 1,
    xdgDir: null,
    log,
  };
  proc.rpc = (method, params) => {
    if (proc.dead || child.stdin.destroyed) {
      return Promise.reject(new Error("devin acp process not running"));
    }
    const id = proc.idCounter++;
    return new Promise((resolve, reject) => {
      proc.pending.set(id, { resolve, reject });
      try {
        child.stdin.write(rpc(method, params, id));
      } catch (e) {
        proc.pending.delete(id);
        reject(e);
      }
    });
  };
  child.stdout.on("data", (chunk) => {
    proc.buf += chunk.toString("utf8");
    let nl;
    while ((nl = proc.buf.indexOf("\n")) !== -1) {
      const line = proc.buf.slice(0, nl).trim();
      proc.buf = proc.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON banner/log lines
      }
      if (msg.id !== undefined && proc.pending.has(msg.id)) {
        const p = proc.pending.get(msg.id);
        proc.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || "Devin ACP error");
          err.code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
        continue;
      }
      if (msg.method || msg.error) proc.handler?.(msg);
    }
  });
  child.stderr.on("data", (chunk) => {
    log?.debug?.("DEVIN", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
  });
  const onDead = () => {
    if (proc.dead) return;
    proc.dead = true;
    for (const p of proc.pending.values()) p.reject(new Error("devin acp exited"));
    proc.pending.clear();
    const h = proc.handler;
    proc.handler = null;
    h?.onClose?.(proc.exitCode);
    if (proc.sig && acpPool.has(proc.sig)) {
      const rest = acpPool.get(proc.sig).filter((x) => x !== proc);
      if (rest.length) acpPool.set(proc.sig, rest);
      else acpPool.delete(proc.sig);
      acpPoolSize--;
    }
    if (proc.xdgDir) {
      try {
        fs.rmSync(proc.xdgDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      proc.xdgDir = null;
    }
  };
  child.on("error", onDead);
  child.on("close", (code) => {
    proc.exitCode = code;
    onDead();
  });
  return proc;
}

async function acquireAcpProc({ sig, devinBin, acpArgs, env, cwd, mcpServers, log }) {
  const list = acpPool.get(sig) || [];
  const idle = list.find((p) => !p.busy && !p.dead);
  if (idle) {
    idle.busy = true;
    return { proc: idle, pooled: true };
  }

  const spawnEnv = { ...env };
  let xdgDir = null;
  if (mcpServers && Object.keys(mcpServers).length) {
    xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-mcp-"));
    const cfgDev = path.join(xdgDir, "devin");
    fs.mkdirSync(cfgDev, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDev, "config.json"),
      JSON.stringify({ mcpServers })
    );
    spawnEnv.XDG_CONFIG_HOME = xdgDir;
    log?.info?.("DEVIN", `mcp config written → ${xdgDir}`);
  }

  const pooled = acpPoolSize < ACP_POOL_MAX;
  const proc = spawnAcpProc(devinBin, acpArgs, spawnEnv, cwd, pooled ? sig : null, log);
  proc.xdgDir = xdgDir;
  try {
    await proc.rpc("initialize", {
      protocolVersion: "0.3",
      clientInfo: { name: "9router", version: "1.0" },
      capabilities: {},
    });
  } catch (e) {
    try {
      proc.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw e;
  }
  if (pooled) {
    acpPool.set(sig, [...list, proc]);
    acpPoolSize++;
  }
  return { proc, pooled };
}

function releaseAcpProc(proc, pooled) {
  proc.handler = null;
  if (pooled && !proc.dead) {
    proc.busy = false;
    return;
  }
  try {
    proc.child.stdin.end();
  } catch {
    /* ignore */
  }
  const t = setTimeout(() => {
    if (!proc.child.killed) proc.child.kill("SIGKILL");
  }, 2000);
  t.unref?.();
}

// Extract a JSON payload from an agent reply: strips ```json fences, drops
// leading/trailing prose around the outermost {…} block. Returns the raw text
// when nothing parses — the client reports the contract violation itself.
function extractJsonText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* fallthrough */
  }
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      /* fallthrough */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* fallthrough */
    }
  }
  return trimmed;
}

// ─── DevinCliExecutor ─────────────────────────────────────────────────────────

export class DevinCliExecutor extends BaseExecutor {
  constructor() {
    super("devin-cli", { id: "devin-cli", baseUrl: "devin://acp/stdio" });
  }

  buildUrl() {
    return "devin://acp/stdio";
  }

  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  async execute({ model, body, credentials, signal, log }) {
    const b = body ?? {};
    const messages = Array.isArray(b.messages)
      ? b.messages
      : Array.isArray(b.input)
        ? b.input
        : [];
    let promptText = buildPromptText(messages);

    // Structured output: AI SDK Output.object / generateObject send
    // response_format {type:"json_schema"|"json_object"}. The ACP agent has no
    // JSON mode, so enforce it at prompt level and buffer the reply into a
    // single clean JSON delta at the end.
    const rf = b.response_format;
    const jsonMode = rf?.type === "json_schema" || rf?.type === "json_object";
    if (jsonMode) {
      const schema = rf?.json_schema?.schema;
      promptText +=
        "\n\n[Output contract] Respond with ONLY a valid JSON object" +
        (schema ? ` matching this JSON Schema:\n${JSON.stringify(schema)}` : "") +
        "\nNo prose, no explanation, no markdown code fences.";
    }
    // Non-streaming clients (AI SDK generateObject/Output.object use
    // doGenerate) expect a JSON body — an SSE stream fails to parse as
    // "Invalid JSON response". Buffer everything and emit one JSON object.
    const nonStream = b.stream !== true;
    const workspaceCwd = resolveWorkspaceCwd(b);
    const devinBin = resolveDevinBin();

    log?.info?.(
      "DEVIN",
      `devin acp → model=${model}, bin=${devinBin}, cwd=${workspaceCwd}`
    );

    // Optional MCP servers via DEVIN_MCP_SERVERS (JSON object, devin config format):
    //   {"echo":{"command":"/abs/node","args":["/srv/echo.js"],"env":{"K":"V"}}}
    // Plus body.tools (OpenAI schema) → exposed as a "clientTools" MCP
    // server so devin can invoke client-defined tools (bridged back in Phase 2).
    // devin reads the MCP config from XDG_CONFIG_HOME/devin/config.json once at
    // process boot (the session/new mcpServers param is ignored), so the config
    // is written per pooled process and the pool key includes it.
    // NOTE: this replaces the user's global devin MCP config for the subprocess.
    const mcpServers = {};
    const mcpJson = process.env.DEVIN_MCP_SERVERS?.trim();
    if (mcpJson) {
      try {
        Object.assign(mcpServers, JSON.parse(mcpJson));
      } catch (e) {
        log?.info?.("DEVIN", `DEVIN_MCP_SERVERS parse failed: ${e.message}`);
      }
    }
    const clientTools = Array.isArray(b.tools) ? b.tools.filter(Boolean) : [];
    const clientToolResults = extractClientToolResults(messages);
    const clientToolsMcp = buildClientToolsMcp(clientTools, clientToolResults);
    const hasClientTools = !!clientToolsMcp;
    if (clientToolsMcp) {
      mcpServers["clientTools"] = clientToolsMcp;
      const seeded = Object.keys(clientToolResults).length;
      log?.info?.(
        "DEVIN",
        `exposing ${clientTools.length} client tool(s) as MCP` +
          (seeded ? ` (seeded ${seeded} result(s))` : "")
      );
    }
    // Pool-stable variant: seeded DEVIN_MCP_RESULTS are per-request data (a
    // warm process would serve stale values to later requests), so pooled
    // configs drop them — results still reach the agent inlined in the prompt.
    const mcpServersStable = { ...mcpServers };
    if (mcpServersStable.clientTools?.env) {
      const stableEnv = { ...mcpServersStable.clientTools.env };
      delete stableEnv.DEVIN_MCP_RESULTS;
      mcpServersStable.clientTools = { ...mcpServersStable.clientTools, env: stableEnv };
    }

    // Agent type: default (omitted) = full agent with built-in tools
    // (fs/shell/search) so the model can actually perform tasks. Override to
    // `summarizer` (no tools, text-only) via CLI_DEVIN_AGENT_TYPE for a safer,
    // tool-less mode. WARNING: the default agent can run shell commands and
    // modify the filesystem on the host running 9router — only expose locally.
    const agentType = process.env.CLI_DEVIN_AGENT_TYPE?.trim();
    const acpArgs = ["acp"];
    if (agentType) acpArgs.push("--agent-type", agentType);
    const sig = acpSig(agentType, mcpServersStable, workspaceCwd);

    const sseStream = new ReadableStream({
      start(controller) {
        (async () => {
        const enc = new TextEncoder();
        // DEVIN_DEBUG_DUMP=/path → mirror raw SSE emissions for postmortem.
        const dumpPath = process.env.DEVIN_DEBUG_DUMP;
        const emit = (data) => {
          if (dumpPath) {
            try { fs.appendFileSync(dumpPath, data); } catch { /* debug only */ }
          }
          controller.enqueue(enc.encode(data));
        };

        // Inherit the parent environment so devin resolves stored CLI credentials
        // (~/.local/share/devin/credentials.toml from `devin auth login`). Do NOT
        // inject WINDSURF_API_KEY: this provider is noAuth, and a bogus/leaked key
        // overrides stored creds and makes devin return -32000 "invalid api key".
        const env = { ...process.env };
        // Auto-approve tool execution so the agent doesn't block waiting for a
        // session/request_permission response we never send (default mode would
        // hang the stream on the first shell/exec tool call). Override via env.
        // WARNING: bypass lets the agent run shell/modify FS unattended — local only.
        env.DEVIN_PERMISSION_MODE = process.env.DEVIN_PERMISSION_MODE || "bypass";

        // ── per-request stream state ──────────────────────────────────────
        let sessionId = null;
        const responseId = `chatcmpl-devin-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let roleEmitted = false;
        let totalText = "";
        let finished = false;

        let proc = null;
        let pooled = false;
        let releaseDone = false;
        const release = () => {
          if (releaseDone || !proc) return;
          releaseDone = true;
          releaseAcpProc(proc, pooled);
        };

        // Emit a content delta as an OpenAI-compatible SSE chunk (handles the
        // leading role chunk once). Buffered modes (jsonMode, nonStream) emit
        // the full reply in finish() instead.
        const emitDelta = (delta) => {
          if (jsonMode || nonStream) {
            totalText += delta;
            return;
          }
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          totalText += delta;
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`
          );
        };

        // Emit an OpenAI tool_call delta (function calling). Ends the turn with
        // finish_reason "tool_calls" so the client executes and returns tool_result.
        let toolUseEmitted = false;
        // ACP tool_call is upsert-by-id: the first event has title, a later update
        // may only carry rawInput (title omitted). Track pending client-tool calls.
        const pendingClientTools = new Map(); // toolCallId → original tool name
        let bufferedToolCall = null; // nonStream: {id, name, argsStr}
        const emitToolUse = (toolName, args, toolCallId) => {
          const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
          if (nonStream) {
            bufferedToolCall = {
              id: toolCallId || `call_${Date.now()}`,
              name: toolName,
              argsStr,
            };
            return;
          }
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCallId,
                        type: "function",
                        function: { name: toolName, arguments: argsStr },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          );
        };

        const finish = (error, finishReason = "stop") => {
          if (finished) return;
          finished = true;

          if (error) {
            emit(
              `data: ${JSON.stringify({ error: { message: error, type: "devin_cli_error" } })}\n\n`
            );
          } else {
            // Buffered replies (jsonMode / nonStream) go out as one delta —
            // still SSE; chatCore converts to a JSON body for non-stream
            // clients upstream.
            if ((jsonMode || nonStream) && totalText) {
              const text = jsonMode ? extractJsonText(totalText) : totalText;
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
                })}\n\n`
              );
              roleEmitted = true;
            }
            // Buffered non-stream tool call: same SSE shape as streaming.
            if (nonStream && bufferedToolCall) {
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: bufferedToolCall.id,
                            type: "function",
                            function: { name: bufferedToolCall.name, arguments: bufferedToolCall.argsStr },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
              roleEmitted = true;
            }
            if (bufferedToolCall) finishReason = "tool_calls";
            // Emit finish chunk
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage: {
                  prompt_tokens: Math.ceil(promptText.length / 4),
                  completion_tokens: Math.ceil(totalText.length / 4),
                  total_tokens: Math.ceil((promptText.length + totalText.length) / 4),
                  estimated: true,
                },
              })}\n\n`
            );
          }
          emit("data: [DONE]\n\n");
          release();
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };

        // ── ACP process: warm pooled process (same tool-set signature) or a
        // fresh spawn. Notifications route through proc.handler. ─────────────
        let acquireErr = null;
        try {
          ({ proc, pooled } = await acquireAcpProc({
            sig,
            devinBin,
            acpArgs,
            env,
            cwd: workspaceCwd,
            mcpServers: mcpServersStable,
            log,
          }));
        } catch (e) {
          acquireErr = e;
        }

        if (acquireErr) {
          const msg =
            acquireErr.code === "ENOENT" ||
            String(acquireErr.message || "").includes("not found")
              ? `Devin CLI not found: ${devinBin}. Install via https://cli.devin.ai or set CLI_DEVIN_BIN env var.`
              : `Devin CLI spawn error: ${acquireErr.message}`;
          emit(
            `data: ${JSON.stringify({ error: { message: msg, type: "devin_cli_error", code: "spawn_failed" } })}\n\n`
          );
          emit("data: [DONE]\n\n");
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          return;
        }

        if (signal) {
          signal.addEventListener("abort", () => {
            // A prompt may be mid-flight: a killed process is evicted from the
            // pool by onDead instead of being reused with dirty session state.
            if (proc && !proc.child.killed) {
              try {
                proc.child.kill("SIGTERM");
              } catch {
                /* ignore */
              }
            }
          });
        }

        proc.handler = (msg) => {
          // ── Permission requests → auto-approve the first allow option ──
          // devin asks before running shell/exec tools; as a headless proxy we
          // grant once. (DEVIN_PERMISSION_MODE=bypass usually prevents these,
          // but some tool kinds still prompt, so handle them here too.)
          if (msg.method === "session/request_permission" && msg.id !== undefined) {
            const options = msg.params?.options || [];
            const allow =
              options.find((o) => /allow/i.test(String(o.kind || ""))) || options[0];
            if (allow) {
              try {
                proc.child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { outcome: { outcome: "selected", optionId: allow.optionId } },
                  }) + "\n"
                );
              } catch {
                /* ignore */
              }
            }
            return;
          }

          // ── Agent stopped notification (devin 3000.2.x stop signal) ───
          if (msg.method === "_cognition.ai/agent_stopped" || msg.method === "$/agent_stopped") {
            const cause = msg.params?.cause;
            if (cause === "error") {
              // devin uses errorMessage on this notification (not message/error).
              const errText =
                msg.params?.errorMessage ||
                msg.params?.message ||
                msg.params?.error ||
                "Devin agent error";
              finish(String(errText));
            } else {
              finish();
            }
            return;
          }

          // ── Streaming notifications (session/update) ──────────────────
          if (msg.method === "session/update" || msg.method === "$/update") {
            const params = msg.params;
            if (!params) return;

            // devin 3000.2.x nests the payload under params.update.sessionUpdate;
            // older devin used a flat params.type.
            const update = params.update || {};
            const type = update.sessionUpdate || params.type;
            const contentField = update.content !== undefined ? update.content : params.content;
            const deltaText =
              typeof contentField === "string"
                ? contentField
                : contentField?.text ?? params.delta ?? params.text ?? "";

            // ── Client-tool bridge: devin calling a tool from our exposed MCP ──
            // ACP title shape: "Calling mcp_<name> from clientTools".
            // tool_call is upsert-by-id: title may only appear on the first event,
            // rawInput on a later tool_call_update. Track pending ids so we don't
            // require both fields on the same notification.
            if (
              hasClientTools &&
              !toolUseEmitted &&
              (type === "tool_call" || type === "tool_call_update")
            ) {
              const tcId = update.toolCallId;
              if (typeof update.title === "string" && update.title.startsWith("Calling mcp_") && /from clientTools\b/.test(update.title)) {
                const nameMatch = update.title.match(/^Calling (mcp_\S+)\b/);
                const mcpName = nameMatch ? nameMatch[1] : "";
                const origName = fromMcpToolName(mcpName);
                if (tcId && origName) pendingClientTools.set(tcId, origName);
              }
              const origName = tcId ? pendingClientTools.get(tcId) : null;
              if (origName && update.rawInput) {
                toolUseEmitted = true;
                pendingClientTools.delete(tcId);
                emitToolUse(origName, update.rawInput, tcId || `call_${Date.now()}`);
                finish(null, "tool_calls");
              }
              return;
            }

            if (type === "agent_message_chunk" || type === "message_delta" || type === "text_delta" || type === "content_delta") {
              if (deltaText) emitDelta(deltaText);
            } else if (type === "agent_thought_chunk") {
              // Internal reasoning — not surfaced to the client.
            } else if (type === "message_stop" || type === "stop" || type === "done") {
              finish();
            } else if (type === "error") {
              finish(String(params.message || params.error || "Devin ACP error"));
            }
            return;
          }

          // ── Error responses ───────────────────────────────────────────
          if (msg.error) {
            finish(`Devin ACP error ${msg.error.code}: ${msg.error.message}`);
          }
        };
        proc.handler.onClose = (code) => {
          if (finished) return;
          finish(roleEmitted || code === 0 ? undefined : `Devin CLI exited with code ${code}`);
        };

        try {
          // `mcpServers` is required by devin 3000.2.x (must be a sequence);
          // omitting it returns -32602. Server defs come from the process boot
          // config (XDG), not this param — see the acpPool comment.
          const res = await proc.rpc("session/new", {
            cwd: workspaceCwd,
            mcpServers: [],
            model: model || undefined,
          });
          sessionId = res?.sessionId || null;
          if (!sessionId) {
            finish("Devin ACP: session/new returned no sessionId");
            return;
          }
          // devin 3000.2.x expects `prompt` (a sequence), not `content` — using
          // `content` returns -32602 "missing field prompt". The call resolves
          // with the final result (stopReason) after streaming completes.
          proc
            .rpc("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: promptText }],
            })
            .then((res) => {
              if (!roleEmitted) {
                // jsonMode keeps roleEmitted false while buffering; the final
                // result text is only a fallback when nothing streamed.
                if (!jsonMode || !totalText) {
                  const content = extractResultText(res);
                  if (content) {
                    totalText = content;
                    emitDelta(content);
                  }
                }
                const stopReason = res?.stopReason || "";
                if (stopReason && stopReason !== "cancelled") finish();
              }
            })
            .catch((e) => {
              finish(`Devin ACP error ${e.code}: ${e.message}`);
            });
        } catch (e) {
          finish(`Devin ACP error ${e.code || ""}: ${e.message}`);
        }
        })().catch((e) => {
          emit(
            `data: ${JSON.stringify({ error: { message: `devin acp: ${e.message}`, type: "devin_cli_error" } })}\n\n`
          );
          emit("data: [DONE]\n\n");
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });

    return {
      response: new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: "devin://acp/stdio",
      headers: {},
      transformedBody: {
        model,
        cwd: workspaceCwd,
        clientTools: clientTools.map((t) => t?.function?.name || t?.name).filter(Boolean),
        clientToolResults: Object.keys(clientToolResults),
        mcpServers: Object.keys(mcpServers),
        promptLength: Array.isArray(body?.messages)
          ? body.messages.length
          : Array.isArray(body?.input)
            ? body.input.length
            : 0,
      },
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extract text from a final ACP session/prompt result object across common shapes.
function extractResultText(result) {
  // { message: { content: "..." } }
  // { messages: [{ content: "..." }] }
  // { content: "..." }
  // { text: "..." }
  if (typeof result.content === "string") return result.content;
  if (typeof result.text === "string") return result.text;
  const msg = result.message;
  if (msg && typeof msg.content === "string") return msg.content;
  const msgs = result.messages;
  if (Array.isArray(msgs)) {
    return msgs
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  }
  return "";
}

export default DevinCliExecutor;

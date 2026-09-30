// Opt-in integration test. Run in a disposable Herdr shell pane, not a full TUI.
// Uses empty OpenCode sessions and simulated lifecycle events; no model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import plugin from "../tui.js";
import { readService, serviceFile, serviceReady } from "../service.js";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parentID = process.env.HERDR_PANE_ID;
assert.equal(process.env.HERDR_ENV, "1");
assert.ok(parentID);
assert.equal(process.argv[2], "--disposable-pane", "Run this only in a disposable shell pane");
assert.ok(process.env.OPENCODE_TEST_BINARY && isAbsolute(process.env.OPENCODE_TEST_BINARY),
  "Set OPENCODE_TEST_BINARY to an installed OpenCode executable");
const nodeExecutable = process.execPath;
process.execPath = await realpath(process.env.OPENCODE_TEST_BINARY);
const endpoint = await readService(serviceFile());
assert.ok(await serviceReady(endpoint), "Start the shared service before running this test");

async function command(binary, args) {
  const { stdout } = await exec(binary, args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const response = stdout.trim() ? JSON.parse(stdout) : {};
  if (response.error || response._tag) throw new Error(JSON.stringify(response));
  return response;
}
const herdr = async (...args) => (await command("herdr", args)).result;
const api = async (method, path, data) => {
  const response = await fetch(new URL(path, endpoint.url), {
    method: method.toUpperCase(),
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  if (response.status === 204) return;
  const result = await response.json();
  return result.data ?? result;
};

const handlers = new Map();
const sessions = new Map();
const active = new Set();
const ownedPanes = new Map();
const rootSession = "ses_layout_test_parent";
let cleanup;
let warning;
const pending = { list: () => [], sync: async () => {} };
const emit = (type, sessionID) => {
  if (type === "session.created" || type === "session.execution.started") active.add(sessionID);
  else active.delete(sessionID);
  handlers.get(type)?.({ data: { sessionID, parentID: rootSession } });
};

async function waitFor(count) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (warning) throw new Error(warning);
    const { layout } = await herdr("pane", "layout", "--pane", parentID);
    const primary = layout.panes.find((pane) => pane.pane_id === parentID);
    const workers = [];
    let stale = false;
    for (const row of layout.panes) {
      if (row.pane_id === parentID) continue;
      let pane;
      try { ({ pane } = await herdr("pane", "get", row.pane_id)); }
      catch (error) {
        if (!String(error).includes("not_found")) throw error;
        stale = true;
        break;
      }
      if (pane.label !== "Subagent - layout-test") continue;
      ownedPanes.set(pane.pane_id, pane.terminal_id);
      workers.push({ ...row, ...pane });
    }
    if (stale) { await sleep(100); continue; }
    workers.sort((a, b) => a.rect.y - b.rect.y);
    if (workers.length === count) {
      if (count) {
        if (workers.some((pane) => pane.agent_status !== "working")) {
          await sleep(100);
          continue;
        }
        const heights = workers.map((pane) => pane.rect.height);
        const width = primary.rect.width + workers[0].rect.width;
        if (Math.max(...heights) - Math.min(...heights) > 2) { await sleep(100); continue; }
        assert.ok(Math.abs(primary.rect.width / width - 0.6) < 0.04);
        for (const pane of workers) {
          assert.equal(pane.rect.x, workers[0].rect.x);
          assert.equal(pane.rect.width, workers[0].rect.width);
          assert.ok(pane.rect.x > primary.rect.x);
        }
        assert.equal(workers[0].rect.y, primary.rect.y);
        const bottom = workers.at(-1).rect;
        assert.equal(bottom.y + bottom.height, primary.rect.y + primary.rect.height);
      }
      console.log(JSON.stringify({ count, primary, workers }));
      return workers;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${count} workers`);
}

async function waitForMini(panes) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const processes = await Promise.all(panes.map(async (pane) => {
      const { process_info } = await herdr("pane", "process-info", "--pane", pane.pane_id);
      return process_info.foreground_processes ?? [];
    }));
    if (processes.every((items) => items.some((item) =>
      item.cmdline.includes("mini --server") && item.cmdline.includes(endpoint.url)))) return;
    await sleep(100);
  }
  throw new Error("Mini did not attach in all worker panes");
}

const context = {
  options: { autoCloseDelayMs: 200 },
  client: { session: { active: async () => ({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }) } },
  data: {
    on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
    session: {
      get: (id) => id === rootSession ? { id } : sessions.get(id),
      status: (id) => active.has(id) ? "running" : "idle", root: () => rootSession,
      sync: async () => {}, permission: pending, form: pending,
    },
  },
  ui: {
    tabs: { enabled: () => false },
    router: { current: () => ({ type: "session", sessionID: rootSession }) },
    toast: { show: ({ message }) => { warning = message; } },
  },
};

try {
  const serverBefore = await api("get", "/api/info");
  const modelsBefore = (await api("get", "/api/model")).map((model) => `${model.providerID}/${model.id}`).sort();
  for (let i = 0; i < 3; i++) {
    const session = await api("post", "/api/session", {
      title: `Herdr layout test ${i + 1}`, location: { directory: process.cwd() },
    });
    sessions.set(session.id, { ...session, parentID: rootSession, agent: "layout-test" });
  }
  cleanup = await plugin.setup(context);
  assert.equal(typeof cleanup, "function");
  for (const id of sessions.keys()) emit("session.created", id);
  await waitForMini(await waitFor(3));
  const middle = [...sessions.keys()][1];
  emit("session.execution.succeeded", middle);
  await waitFor(2);
  emit("session.execution.started", middle);
  await waitFor(3);
  await cleanup();
  cleanup = undefined;
  await waitFor(0);
  cleanup = await plugin.setup(context);
  await waitForMini(await waitFor(3));
  const serverAfter = await api("get", "/api/info");
  assert.equal(serverAfter.pid, serverBefore.pid, "Mini must not replace the shared service");
  assert.equal(serverAfter.version, serverBefore.version);
  assert.deepEqual((await api("get", "/api/model")).map((model) => `${model.providerID}/${model.id}`).sort(), modelsBefore);
  await cleanup();
  cleanup = undefined;
  await waitFor(0);
  console.log("LIVE ATTACH, LAYOUT, AND RECOVERY PASSED");
} finally {
  await cleanup?.();
  // Close only test panes whose terminal identity still matches.
  for (const [paneID, terminalID] of ownedPanes) {
    try {
      const { pane } = await herdr("pane", "get", paneID);
      if (pane.terminal_id === terminalID) await herdr("pane", "close", paneID);
    } catch (error) { if (!String(error).includes("not_found")) console.error(error); }
  }
  for (const id of sessions.keys()) await api("delete", `/api/session/${id}`).catch(console.error);
  process.execPath = nodeExecutable;
  console.log("LIVE TEST CLEANUP COMPLETE");
}

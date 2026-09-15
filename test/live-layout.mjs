// Opt-in integration test. Run in a disposable Herdr shell pane, not a full TUI.
// Uses empty OpenCode sessions and simulated lifecycle events; no model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import plugin from "../tui.js";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parentID = process.env.HERDR_PANE_ID;
assert.equal(process.env.HERDR_ENV, "1");
assert.ok(parentID);
assert.equal(process.argv[2], "--disposable-pane", "Run this only in a disposable shell pane");

async function command(binary, args) {
  const { stdout } = await exec(binary, args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const response = stdout.trim() ? JSON.parse(stdout) : {};
  if (response.error || response._tag) throw new Error(JSON.stringify(response));
  return response;
}
const herdr = async (...args) => (await command("herdr", args)).result;
const api = async (method, path, data) => (await command("opencode2", [
  "api", method, path, ...(data === undefined ? [] : ["--data", JSON.stringify(data)]),
])).data;

const handlers = new Map();
const sessions = new Map();
const ownedPanes = new Map();
const rootSession = "ses_layout_test_parent";
let cleanup;
let warning;
const pending = { list: () => [], sync: async () => {} };
const emit = (type, sessionID) => handlers.get(type)?.({ data: { sessionID, parentID: rootSession } });

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
      if (!pane.label?.startsWith("subagent: layout-test")) continue;
      ownedPanes.set(pane.pane_id, pane.terminal_id);
      workers.push(row);
    }
    if (stale) { await sleep(100); continue; }
    workers.sort((a, b) => a.rect.y - b.rect.y);
    if (workers.length === count) {
      if (count) {
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
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${count} workers`);
}

try {
  for (let i = 0; i < 3; i++) {
    const session = await api("post", "/api/session", {
      title: `Herdr layout test ${i + 1}`, location: { directory: process.cwd() },
    });
    sessions.set(session.id, { ...session, parentID: rootSession, agent: "layout-test" });
  }
  cleanup = await plugin.setup({
    options: { commandPrefix: ["devx"], autoCloseDelayMs: 200 },
    data: {
      on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
      session: { get: (id) => sessions.get(id), status: () => "running", root: () => rootSession,
        sync: async () => {}, permission: pending, form: pending },
    },
    ui: {
      tabs: { enabled: () => false },
      router: { current: () => ({ type: "session", sessionID: rootSession }) },
      toast: { show: ({ message }) => { warning = message; } },
    },
  });
  assert.equal(typeof cleanup, "function");
  for (const id of sessions.keys()) emit("session.created", id);
  await waitFor(3);
  await sleep(3000);
  const middle = [...sessions.keys()][1];
  emit("session.execution.succeeded", middle);
  await waitFor(2);
  emit("session.execution.started", middle);
  await waitFor(3);
  await cleanup();
  cleanup = undefined;
  await waitFor(0);
  console.log("LIVE LAYOUT PASSED");
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
}

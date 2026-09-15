import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

const source = await readFile(new URL("../tui.js", import.meta.url), "utf8");
const layoutSource = await readFile(new URL("../layout.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const inside = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/fake.sock" };

// Load the actual source with fake process, command, timer, and OpenCode APIs.
// No command in this test file can reach Herdr or an OpenCode service.
async function fixture(settings = {}) {
  const calls = [];
  const warnings = [];
  const timers = new Map();
  const handlers = new Map();
  const sessions = new Map();
  const statuses = new Map();
  const permissions = new Map();
  const forms = new Map();
  const panes = new Map();
  const overrides = new Map();
  const holds = new Map();
  const state = { route: "ses_root", tabs: [], shellPID: 100, root: { type: "pane", pane_id: "w1:p1" } };
  let now = 0;
  let nextTimer = 0;
  let nextPane = 1;
  const json = (result) => JSON.stringify({ result }, null, settings.prettyJson ? 2 : undefined);
  const notFound = () => Object.assign(new Error("Command failed"), {
    stderr: JSON.stringify({ error: { code: settings.notFoundCode ?? "pane_not_found" } }),
  });

  function prune(node) {
    if (node.type === "pane") return node.pane_id === "w1:p1" || panes.has(node.pane_id) ? node : undefined;
    const first = prune(node.first);
    const second = prune(node.second);
    return first && second ? { ...node, first, second } : first ?? second;
  }

  function splitAt(node, target, pane, direction, ratio) {
    if (node.type === "pane") {
      return node.pane_id === target ? { type: "split", direction, ratio, first: node, second: { type: "pane", pane_id: pane.pane_id } } : node;
    }
    return { ...node, first: splitAt(node.first, target, pane, direction, ratio), second: splitAt(node.second, target, pane, direction, ratio) };
  }

  function execFile(binary, args, options, callback) {
    const op = binary === "herdr" ? args[1] : binary;
    calls.push({ binary, args: [...args], options, op });
    const complete = () => {
      try {
        const override = overrides.get(op)?.shift();
        if (override instanceof Error) throw override;
        if (typeof override === "string") return callback(null, override, "");
        if (op === "which") return callback(null, settings.prefixBinary ?? "/fake/devx\n", "");
        if (op === "ps") return callback(null, settings.processes ?? "1 0\n100 1\n700 100\n", "");
        let result;
        switch (op) {
          case "process-info":
            result = { process_info: { pane_id: "w1:p1", shell_pid: state.shellPID } };
            break;
          case "split": {
            state.root = prune(state.root);
            const pane = { pane_id: `w1:p${++nextPane}`, terminal_id: `term_${nextPane}` };
            state.root = splitAt(state.root, args[args.indexOf("--pane") + 1], pane,
              args[args.indexOf("--direction") + 1], Number(args[args.indexOf("--ratio") + 1]));
            panes.set(pane.pane_id, pane);
            result = { pane };
            break;
          }
          case "get":
            if (!panes.has(args[2])) throw notFound();
            result = { pane: panes.get(args[2]) };
            break;
          case "close":
            if (!panes.delete(args[2])) throw notFound();
            state.root = prune(state.root);
            result = { type: "pane_closed", pane_id: args[2] };
            break;
          case "layout.export":
            state.root = prune(state.root);
            result = { layout: { tab_id: "w1:t1", root: state.root } };
            break;
          case "layout.set_split_ratio": {
            const params = JSON.parse(args[2]);
            assert.equal(params.tab_id, "w1:t1");
            let node = state.root;
            for (const second of params.path) node = second ? node.second : node.first;
            assert.equal(node.type, "split");
            node.ratio = params.ratio;
            result = { type: "layout_split_ratio_set" };
            break;
          }
          case "rename":
            result = { type: "pane_info", pane: panes.get(args[2]) };
            break;
          case "report-agent":
          case "release-agent":
            if (!panes.has(args[2])) throw notFound();
            result = { type: "pane_info", pane: panes.get(args[2]) };
            break;
          case "run":
            return callback(null, "", "");
          default:
            throw new Error(`Unexpected mock command: ${binary} ${args.join(" ")}`);
        }
        callback(null, json(result), "");
      } catch (error) {
        callback(error);
      }
    };
    const held = holds.get(op)?.shift();
    if (held) held.release = complete;
    else complete();
  }
  // node:child_process has a custom promisifier that returns both streams.
  execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });

  const sandbox = vm.createContext({
    process: { env: settings.env ?? inside, argv: settings.argv ?? ["opencode2"], pid: 700 },
    console: { warn: (message) => warnings.push(message) },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const module = new vm.SourceTextModule(source, { context: sandbox });
  const modules = {
    "./layout.js": new vm.SourceTextModule(layoutSource, { context: sandbox }),
    "node:net": new vm.SyntheticModule(["default"], function () {
      this.setExport("default", {
        createConnection(_endpoint, connected) {
          const socket = new EventEmitter();
          socket.destroy = () => { socket.destroyed = true; };
          socket.write = (text) => {
            const request = JSON.parse(text);
            execFile("herdr", ["rpc", request.method, JSON.stringify(request.params)], {}, (error, stdout) => {
              if (socket.destroyed) return;
              if (error) return socket.emit("error", error);
              let response;
              try { response = JSON.stringify({ id: request.id, ...JSON.parse(stdout) }); }
              catch { response = stdout; }
              socket.emit("data", `${response}\n`);
            });
          };
          queueMicrotask(connected);
          return socket;
        },
      });
    }, { context: sandbox }),
    "node:child_process": new vm.SyntheticModule(["execFile"], function () {
      this.setExport("execFile", execFile);
    }, { context: sandbox }),
    "node:util": new vm.SyntheticModule(["promisify"], function () {
      this.setExport("promisify", promisify);
    }, { context: sandbox }),
  };
  await module.link((name) => {
    assert.ok(modules[name], `Unexpected import: ${name}`);
    return modules[name];
  });
  await module.evaluate();
  const context = {
    options: settings.options ?? {},
    data: {
      on(type, handler) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      session: {
        get: (id) => sessions.get(id),
        status: (id) => statuses.get(id) ?? "idle",
        sync: async (id) => settings.sync?.(id, sessions),
        root: (id) => id === "ses_nested" ? "ses_root" : id,
        permission: {
          list: (id) => permissions.get(id),
          sync: async (id) => settings.syncPermissions?.(id, permissions),
        },
        form: {
          list: (id) => forms.get(id),
          sync: async (id) => settings.syncForms?.(id, forms),
        },
      },
    },
    ui: {
      tabs: { enabled: () => settings.tabsEnabled ?? false, list: () => state.tabs },
      router: { current: () => ({ type: "session", sessionID: state.route }) },
      toast: { show: () => { if (settings.toastThrows) throw new Error("TUI disposed"); } },
    },
  };
  const inaccessible = new Proxy({}, { get() { throw new Error("Inactive plugin accessed context"); } });
  const cleanup = await module.namespace.default.setup(settings.forbidContext ? inaccessible : context);
  return {
    calls, warnings, timers, handlers, sessions, statuses, permissions, forms, panes, state, cleanup,
    commands: (op) => calls.filter((call) => call.op === op),
    override(op, value) {
      const list = overrides.get(op) ?? [];
      overrides.set(op, [...list, value]);
    },
    hold(op) {
      const gate = {};
      holds.set(op, [...(holds.get(op) ?? []), gate]);
      return gate;
    },
    async emit(type, data) {
      handlers.get(type)?.({ data });
      await flush();
    },
    async create(id = "ses_child", info = {}) {
      const session = {
        id, parentID: "ses_root", agent: "explore", location: { directory: "/child/project" }, ...info,
      };
      sessions.set(id, session);
      await this.emit("session.created", { sessionID: id, parentID: session.parentID });
    },
    async start(id = "ses_child") {
      await this.emit("session.execution.started", { sessionID: id });
    },
    async finish(id = "ses_child", outcome = "succeeded") {
      await this.emit(`session.execution.${outcome}`, { sessionID: id });
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("server entrypoint does nothing", async () => {
  const module = new vm.SourceTextModule(serverSource);
  await module.link(() => { throw new Error("Unexpected server import"); });
  await module.evaluate();
  module.namespace.default.setup(new Proxy({}, { get() { throw new Error("Context accessed"); } }));
});

for (const [name, env] of [
  ["outside Herdr", {}],
  ["Herdr disabled", { ...inside, HERDR_ENV: "0" }],
  ["missing pane ID", { HERDR_ENV: "1" }],
  ["missing socket path", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }],
  ["relative pane ID", { ...inside, HERDR_PANE_ID: "1" }],
  ["blank pane ID", { ...inside, HERDR_PANE_ID: " " }],
  ["generated child pane", { ...inside, OPENCODE_HERDR_SUBAGENT_PANE: "1" }],
]) {
  test(`${name}: no commands, timers, or context access`, async () => {
    const f = await fixture({ env, forbidContext: true });
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.handlers.size, 0);
  });
}

for (const args of [["--standalone"], ["--server", "https://server.example"], ["--server=http://localhost:4096"]]) {
  test(`private connection ${args[0]} is refused without Herdr commands`, async () => {
    const f = await fixture({ argv: ["opencode2", ...args] });
    assert.equal(f.calls.length, 0);
    assert.equal(f.handlers.size, 0);
    assert.match(f.warnings[0], /shared OpenCode service/);
  });
}

test("stale Herdr environment cannot control a different pane", async () => {
  const f = await fixture({ processes: "1 0\n100 1\n700 500\n500 1\n" });
  assert.equal(f.handlers.size, 0);
  assert.equal(f.commands("split").length, 0);
  assert.equal(f.commands("which").length, 0);
  assert.match(f.warnings[0], /does not belong/);
});

test("configured devx prefix is resolved once", async () => {
  const f = await fixture({ options: { commandPrefix: ["devx"] } });
  await f.create();
  await f.create("ses_other");
  assert.equal(f.commands("which").length, 1);
  assert.deepEqual(f.commands("which")[0].args, ["devx"]);
  assert.match(f.commands("run")[0].args[3], /^'\/fake\/devx' opencode2 mini --session 'ses_child'$/);
  await f.cleanup();
});

test("a missing configured prefix executable disables the plugin", async () => {
  const f = await fixture({ prefixBinary: "", options: { commandPrefix: ["devx"] } });
  assert.equal(f.handlers.size, 0);
  assert.equal(f.commands("split").length, 0);
});

for (const [name, options] of [["omitted", {}], ["empty", { commandPrefix: [] }]]) {
  test(`${name} prefix launches Mini directly without executable discovery`, async () => {
    const f = await fixture({ options });
    await f.create();
    assert.equal(f.commands("which").length, 0);
    assert.equal(f.commands("run")[0].args[3], "opencode2 mini --session 'ses_child'");
    await f.cleanup();
  });
}

test("a custom prefix preserves arguments and quotes shell characters", async () => {
  const commandPrefix = ["wrapper", "--label", "space ' $(not-a-command); &"];
  const f = await fixture({ prefixBinary: "/fake/wrapper\n", options: { commandPrefix } });
  await f.create();
  assert.deepEqual(f.commands("which")[0].args, ["wrapper"]);
  assert.equal(f.commands("run")[0].args[3],
    "'/fake/wrapper' '--label' 'space '\\'' $(not-a-command); &' opencode2 mini --session 'ses_child'");
  assert.deepEqual(commandPrefix, ["wrapper", "--label", "space ' $(not-a-command); &"]);
  await f.cleanup();
});

test("invalid prefix options disable pane operations instead of silently dropping the prefix", async () => {
  for (const commandPrefix of [null, "devx", false, {}, [42], [""], [" "], ["-a"], ["devx", "bad\narg"], ["devx\0"]]) {
    const f = await fixture({ options: { commandPrefix } });
    assert.equal(f.handlers.size, 0);
    assert.equal(f.commands("which").length, 0);
    assert.equal(f.commands("split").length, 0);
    assert.match(f.warnings[0], /commandPrefix/);
  }
});

test("unrelated sessions and disabled tabs are ignored", async () => {
  const f = await fixture();
  f.state.tabs = [{ sessionID: "ses_unrelated" }];
  await f.create("ses_child", { parentID: "ses_unrelated" });
  await f.start();
  assert.equal(f.commands("split").length, 0);
  await f.cleanup();
});

test("nested sessions and enabled tabs are included", async () => {
  const f = await fixture({ tabsEnabled: true });
  f.state.tabs = [{ sessionID: "ses_tab" }];
  await f.create("ses_nested_child", { parentID: "ses_nested" });
  await f.create("ses_tab_child", { parentID: "ses_tab" });
  assert.equal(f.commands("split").length, 2);
  await f.cleanup();
});

test("duplicate creation and start events create one pane", async () => {
  const f = await fixture();
  await f.create();
  await f.create();
  await f.start();
  await f.start();
  assert.equal(f.commands("split").length, 1);
  assert.equal(f.commands("run").length, 1);
  await f.cleanup();
});

test("each pane uses the child directory, marker, and verified split target without focus", async () => {
  const f = await fixture({ prettyJson: true });
  await f.create();
  await f.create("ses_elsewhere", { location: { directory: "/another worktree" } });
  const split = f.commands("split")[1].args;
  assert.equal(split[split.indexOf("--cwd") + 1], "/another worktree");
  assert.equal(split[split.indexOf("--pane") + 1], "w1:p2");
  assert.ok(split.includes("--no-focus"));
  assert.ok(split.includes("OPENCODE_HERDR_SUBAGENT_PANE=1"));
  await f.cleanup();
});

test("a missing cached location is synchronized, not replaced by the parent directory", async () => {
  const f = await fixture({ sync(id, sessions) { sessions.get(id).location = { directory: "/synced/child" }; } });
  await f.create("ses_child", { location: undefined });
  const split = f.commands("split")[0].args;
  assert.equal(split[split.indexOf("--cwd") + 1], "/synced/child");
  await f.cleanup();
});

test("unknown child location causes no split", async () => {
  const f = await fixture();
  await f.create("ses_child", { location: undefined });
  assert.equal(f.commands("split").length, 0);
  await f.cleanup();
});

test("a replaced parent shell causes no split", async () => {
  const f = await fixture();
  f.state.shellPID = 101;
  await f.create();
  assert.equal(f.commands("split").length, 0);
  await f.cleanup();
});

for (const outcome of ["succeeded", "failed"]) {
  test(`${outcome} closes only after its delay; idle events do not shorten it`, async () => {
    const f = await fixture();
    await f.create();
    await f.start();
    await f.emit("session.status", { sessionID: "ses_child", status: "idle" });
    await f.finish("ses_child", outcome);
    const delay = outcome === "failed" ? 5000 : 2000;
    await f.advance(delay - 1);
    assert.equal(f.panes.size, 1);
    await f.advance(1);
    assert.equal(f.panes.size, 0);
    await f.cleanup();
  });
}

test("a stop closes only its worker without the configured completion delay", async () => {
  const f = await fixture({ options: { autoCloseDelayMs: 60000 } });
  for (const id of ["ses_a", "ses_b", "ses_c"]) {
    await f.create(id);
    await f.start(id);
  }
  await f.finish("ses_b", "interrupted");
  await f.advance(0);
  assertColumn(f, ["w1:p2", "w1:p4"]);
  assert.deepEqual(f.commands("close").map(({ args }) => args[2]), ["w1:p3"]);
  assert.equal(f.commands("release-agent").at(-1).args[2], "w1:p3");
  await f.cleanup();
});

test("a worker stop is handled even when the main TUI shows another session", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  f.state.route = "ses_unrelated";
  await f.finish("ses_child", "interrupted");
  await f.advance(0);
  assert.equal(f.panes.size, 0);
  assert.equal(f.timers.size, 0);
  await f.cleanup();
});

test("parent and unrelated interruption events do not close running workers", async () => {
  const f = await fixture();
  await f.create();
  for (const id of ["ses_root", "ses_unrelated", undefined]) {
    await f.emit("session.execution.interrupted", { sessionID: id });
  }
  await f.advance(10000);
  assert.equal(f.commands("close").length, 0);
  await f.cleanup();
});

for (const outcome of ["succeeded", "failed"]) {
  test(`a stop replaces the ${outcome} delay and ignores late terminal events`, async () => {
    const f = await fixture();
    await f.create();
    await f.finish("ses_child", outcome);
    await f.finish("ses_child", "interrupted");
    await f.finish("ses_child", "failed");
    await f.advance(0);
    assert.equal(f.panes.size, 0);
    assert.equal(reportStates(f).at(-1), "idle");
    await f.cleanup();
  });
}

test("a stop reports idle despite stale permission and form caches", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  f.permissions.set("ses_child", [{ id: "per_pending" }]);
  f.forms.set("ses_child", [{ id: "form_pending" }]);
  await f.emit("permission.asked", { sessionID: "ses_child", id: "per_pending" });
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.finish("ses_child", "interrupted");
  assert.equal(reportStates(f).at(-1), "idle");
  await f.advance(0);
  assert.equal(f.panes.size, 0);
  assert.equal(f.timers.size, 0);
  await f.cleanup();
});

for (const operation of ["layout.export", "split", "rename", "run"]) {
  test(`a stop during ${operation} leaves no worker or late Mini launch`, async () => {
    const f = await fixture();
    const gate = f.hold(operation);
    await f.create();
    await f.finish("ses_child", "interrupted");
    await f.advance(0);
    gate.release();
    await flush();
    assert.equal(f.panes.size, 0);
    assert.equal(f.commands("run").length, operation === "run" ? 1 : 0);
    assert.equal(f.timers.size, 0);
    await f.cleanup();
  });
}

test("duplicate stops do not reset bounded close retries", async () => {
  const f = await fixture();
  await f.create();
  for (let i = 0; i < 3; i++) f.override("close", new Error("timeout"));
  await f.finish("ses_child", "interrupted");
  await f.advance(0);
  for (let i = 0; i < 3; i++) {
    await f.finish("ses_child", "interrupted");
    await f.advance(1000);
  }
  assert.equal(f.commands("close").length, 3);
  assert.equal(f.timers.size, 0);
  await f.cleanup();
  assert.equal(f.panes.size, 0);
});

test("a stopped worker with a replaced terminal is not closed or released", async () => {
  const f = await fixture();
  await f.create();
  f.panes.set("w1:p2", { pane_id: "w1:p2", terminal_id: "replacement" });
  await f.finish("ses_child", "interrupted");
  await f.advance(0);
  assert.equal(f.commands("close").length, 0);
  assert.equal(f.commands("release-agent").length, 0);
  await f.cleanup();
});

test("a new execution cancels a stop while the split is in flight", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  await f.create();
  await f.finish("ses_child", "interrupted");
  await f.advance(0);
  await f.start();
  gate.release();
  await flush();
  await f.advance(10000);
  assert.equal(f.panes.size, 1);
  assert.equal(f.commands("run").length, 1);
  assert.equal(reportStates(f).at(-1), "working");
  await f.cleanup();
});

test("a new execution during stop closure opens a replacement worker", async () => {
  const f = await fixture();
  await f.create();
  const gate = f.hold("close");
  await f.finish("ses_child", "interrupted");
  await f.advance(0);
  await f.start();
  gate.release();
  await flush();
  assertColumn(f, ["w1:p3"]);
  assert.equal(reportStates(f, "w1:p3").at(-1), "working");
  await f.cleanup();
});

test("restart cancels a pending close", async () => {
  const f = await fixture();
  await f.create();
  await f.finish();
  await f.start();
  await f.advance(10000);
  assert.equal(f.commands("close").length, 0);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("restart cancels closure even after the user switches to an unrelated session", async () => {
  const f = await fixture();
  await f.create();
  await f.finish();
  f.state.route = "ses_unrelated";
  await f.start();
  await f.advance(10000);
  assert.equal(f.commands("close").length, 0);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("restart cancels a close after its timer fires but before its command", async () => {
  const f = await fixture();
  await f.create();
  const gate = f.hold("get");
  await f.finish();
  await f.advance(2000);
  await f.start();
  gate.release();
  await flush();
  assert.equal(f.commands("close").length, 0);
  await f.cleanup();
});

test("restart during an in-flight close opens a replacement pane", async () => {
  const f = await fixture();
  await f.create();
  const gate = f.hold("close");
  await f.finish();
  await f.advance(2000);
  await f.start();
  gate.release();
  await flush();
  assert.equal(f.commands("split").length, 2);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("reuse after closure opens a new pane from cached session data", async () => {
  const f = await fixture();
  await f.create();
  await f.finish();
  await f.advance(2000);
  await f.start();
  assert.equal(f.commands("split").length, 2);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("panes pending closure still count against the limit", async () => {
  const f = await fixture({ options: { maxPanes: 1 } });
  await f.create();
  await f.finish();
  await f.create("ses_second");
  assert.equal(f.panes.size, 1);
  assert.equal(f.commands("split").length, 1);
  await f.advance(2000);
  await f.start("ses_second");
  assert.equal(f.panes.size, 1);
  assert.equal(f.commands("split").length, 2);
  await f.cleanup();
});

test("concurrent creation events cannot exceed the pane limit", async () => {
  const f = await fixture({ options: { maxPanes: 1 } });
  const gate = f.hold("split");
  await f.create();
  await f.create("ses_second");
  await f.create("ses_third");
  gate.release();
  await flush();
  assert.equal(f.commands("split").length, 1);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("close failure retries while retaining the pane and its capacity slot", async () => {
  const f = await fixture({ options: { maxPanes: 1 } });
  await f.create();
  f.override("close", new Error("timeout"));
  await f.finish();
  await f.advance(2000);
  await f.create("ses_second");
  assert.equal(f.panes.size, 1);
  await f.advance(1000);
  assert.equal(f.commands("close").length, 2);
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

test("close retries are bounded; cleanup makes a final attempt", async () => {
  const f = await fixture();
  await f.create();
  for (let i = 0; i < 3; i++) f.override("close", new Error("timeout"));
  await f.finish();
  await f.advance(20000);
  assert.equal(f.commands("close").length, 3);
  assert.equal(f.timers.size, 0);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
  assert.equal(f.commands("close").length, 4);
  assert.equal(f.panes.size, 0);
});

test("a failed final close is reported and leaves no active timers or handlers", async () => {
  const f = await fixture();
  await f.create();
  await f.finish();
  f.override("close", new Error("timeout"));
  await f.cleanup();
  assert.equal(f.panes.size, 1);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(f.warnings.some((message) => message.includes("close it manually")));
  await f.advance(10000);
  assert.equal(f.commands("close").length, 1);
});

test("restart cancels close retries", async () => {
  const f = await fixture();
  await f.create();
  f.override("close", new Error("timeout"));
  await f.finish();
  await f.advance(2000);
  await f.start();
  await f.advance(10000);
  assert.equal(f.commands("close").length, 1);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("manual closure is treated as success", async () => {
  const f = await fixture();
  await f.create();
  f.panes.clear();
  await f.finish();
  await f.advance(2000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.commands("close").length, 0);
  await f.start();
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("a reused pane ID with a different terminal is never closed", async () => {
  const f = await fixture();
  await f.create();
  f.panes.set("w1:p2", { pane_id: "w1:p2", terminal_id: "term_someone_else" });
  await f.finish();
  await f.advance(2000);
  await f.cleanup();
  assert.equal(f.commands("close").length, 0);
  assert.equal(f.panes.size, 1);
});

test("completion during split leaves no pane behind", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  await f.create();
  await f.finish();
  await f.advance(2000);
  gate.release();
  await flush();
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

test("completion then restart during split still launches Mini once", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  await f.create();
  await f.finish();
  await f.start();
  gate.release();
  await flush();
  await f.advance(10000);
  assert.equal(f.panes.size, 1);
  assert.equal(f.commands("run").length, 1);
  await f.cleanup();
});

test("unload during split closes the resulting pane without launching Mini", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  await f.create();
  const disposed = f.cleanup();
  gate.release();
  await disposed;
  assert.equal(f.panes.size, 0);
  assert.equal(f.commands("run").length, 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.timers.size, 0);
});

test("launch failure closes the pane through the same retry path", async () => {
  const f = await fixture();
  f.override("run", new Error("timeout"));
  f.override("close", new Error("timeout"));
  await f.create();
  await f.advance(0);
  assert.equal(f.panes.size, 1);
  await f.advance(1000);
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

test("restart after launch failure replaces the terminal instead of sending another command into it", async () => {
  const f = await fixture();
  f.override("run", new Error("timeout"));
  await f.create();
  await f.start();
  assert.equal(f.commands("split").length, 2);
  assert.notEqual(f.commands("run")[0].args[2], f.commands("run")[1].args[2]);
  await f.cleanup();
});

test("session deletion overrides a delayed close", async () => {
  const f = await fixture();
  await f.create();
  await f.finish("ses_child", "failed");
  await f.emit("session.deleted", { sessionID: "ses_child" });
  await f.advance(0);
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

test("invalid JSON or API errors cannot be mistaken for a successful split", async () => {
  for (const output of ["notice\n{}", "null", "{}", '{"error":{"code":"invalid_params"}}']) {
    const f = await fixture({ toastThrows: true });
    f.override("split", output);
    await f.create();
    assert.equal(f.commands("run").length, 0);
    assert.ok(f.warnings.length > 0);
    await f.cleanup();
  }
});

test("an unknown split result prevents further creation attempts", async () => {
  const f = await fixture();
  f.override("split", new Error("timeout"));
  await f.create();
  await f.create("ses_second");
  await f.start();
  assert.equal(f.commands("split").length, 1);
  assert.ok(f.warnings.some((message) => message.includes("split result is unknown")));
  await f.cleanup();
});

test("an explicit API rejection does not block later creation", async () => {
  const f = await fixture();
  f.override("split", '{"error":{"code":"invalid_params"}}');
  await f.create();
  await f.create("ses_second");
  assert.equal(f.commands("split").length, 2);
  assert.equal(f.panes.size, 1);
  await f.cleanup();
});

test("shell quoting protects the configured devx path and session ID", async () => {
  const f = await fixture({ prefixBinary: "/fake/O'Brien tools/devx\n", options: { commandPrefix: ["devx"] } });
  await f.create("ses_quote'$(do-not-run)");
  assert.equal(f.commands("run")[0].args[3],
    "'/fake/O'\\''Brien tools/devx' opencode2 mini --session 'ses_quote'\\''$(do-not-run)'");
  await f.cleanup();
});

const reportStates = (f, paneID = "w1:p2") => f.commands("report-agent")
  .filter(({ args }) => args[2] === paneID)
  .map(({ args }) => args[args.indexOf("--state") + 1]);

test("native execution reports child identity and state, never the parent", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  await f.finish();
  assert.deepEqual(reportStates(f), ["idle", "working", "idle"]);
  let sequence = 0;
  for (const { args } of f.commands("report-agent")) {
    assert.equal(args[2], "w1:p2");
    assert.equal(args[args.indexOf("--source") + 1], "herdr:opencode-subagent-panes");
    assert.equal(args[args.indexOf("--agent") + 1], "opencode");
    assert.equal(args[args.indexOf("--agent-session-id") + 1], "ses_child");
    const next = Number(args[args.indexOf("--seq") + 1]);
    assert.ok(next > sequence);
    sequence = next;
  }
  assert.ok(f.commands("split")[0].args.includes("HERDR_AGENT=opencode"));
  await f.advance(2000);
  assert.equal(f.commands("release-agent").length, 1);
  assert.equal(f.timers.size, 0);
  await f.cleanup();
});

test("already-running children use cached status on creation", async () => {
  const f = await fixture();
  f.statuses.set("ses_child", "running");
  await f.create();
  assert.deepEqual(reportStates(f), ["working"]);
  await f.cleanup();
});

test("three child panes report independently for fifteen seconds", async () => {
  const f = await fixture();
  for (const id of ["ses_a", "ses_b", "ses_c"]) {
    await f.create(id);
    await f.start(id);
  }
  await f.advance(15000);
  for (const id of ["w1:p2", "w1:p3", "w1:p4"]) assert.equal(reportStates(f, id).at(-1), "working");
  await f.emit("permission.asked", { sessionID: "ses_b", id: "per_b" });
  assert.equal(reportStates(f, "w1:p2").at(-1), "working");
  assert.equal(reportStates(f, "w1:p3").at(-1), "blocked");
  assert.equal(reportStates(f, "w1:p4").at(-1), "working");
  await f.emit("permission.replied", { sessionID: "ses_b", requestID: "per_b" });
  for (const id of ["ses_a", "ses_b", "ses_c"]) await f.finish(id);
  await f.advance(2000);
  assert.equal(f.panes.size, 0);
  assert.equal(f.commands("release-agent").length, 3);
  await f.cleanup();
});

test("all permissions and forms must clear before a child resumes", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  await f.emit("permission.asked", { sessionID: "ses_child", id: "same_id" });
  await f.emit("form.created", { form: { sessionID: "ses_child", id: "same_id" } });
  await f.emit("permission.replied", { sessionID: "ses_child", requestID: "same_id" });
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.emit("form.cancelled", { sessionID: "ses_child", id: "same_id" });
  assert.equal(reportStates(f).at(-1), "working");
  await f.cleanup();
});

test("late cache snapshots cannot lose an ask or undo a reply", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  f.permissions.set("ses_child", []);
  await f.emit("permission.asked", { sessionID: "ses_child", id: "per_1" });
  assert.equal(reportStates(f).at(-1), "blocked");
  f.permissions.set("ses_child", [{ id: "per_1" }]);
  await f.emit("permission.replied", { sessionID: "ses_child", requestID: "per_1" });
  await f.advance(1000);
  assert.equal(reportStates(f).at(-1), "working");
  await f.cleanup();
});

test("pending requests are hydrated after launch", async () => {
  const f = await fixture({
    syncPermissions(id, permissions) { permissions.set(id, [{ id: "per_existing" }]); },
    syncForms(id, forms) { forms.set(id, [{ id: "form_existing" }]); },
  });
  await f.create();
  await f.start();
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.emit("permission.replied", { sessionID: "ses_child", requestID: "per_existing" });
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.emit("form.replied", { sessionID: "ses_child", id: "form_existing" });
  assert.equal(reportStates(f).at(-1), "working");
  await f.cleanup();
});

test("permission and completion events during split publish only the latest state", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  await f.create();
  await f.start();
  await f.emit("permission.asked", { sessionID: "ses_child", id: "per_1" });
  await f.emit("permission.replied", { sessionID: "ses_child", requestID: "per_1" });
  await f.finish();
  gate.release();
  await flush();
  assert.deepEqual(reportStates(f), ["idle"]);
  await f.advance(2000);
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

test("failed reports retry the latest state without stopping the child", async () => {
  const f = await fixture();
  f.override("report-agent", new Error("socket unavailable"));
  await f.create();
  assert.equal(f.panes.size, 1);
  await f.start();
  await f.advance(500);
  assert.equal(reportStates(f).at(-1), "working");
  await f.cleanup();
  assert.equal(f.timers.size, 0);
});

test("API report errors retry even when the state has no further events", async () => {
  const f = await fixture();
  await f.create();
  f.override("report-agent", '{"error":{"code":"unavailable"}}');
  await f.start();
  assert.equal(f.commands("report-agent").length, 2);
  await f.advance(500);
  assert.equal(f.commands("report-agent").length, 3);
  await f.cleanup();
});

test("an in-flight report cannot leave a stale state as the final report", async () => {
  const f = await fixture();
  await f.create();
  const gate = f.hold("report-agent");
  await f.start();
  await f.emit("permission.asked", { sessionID: "ses_child", id: "per_1" });
  gate.release();
  await flush();
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.cleanup();
});

test("switching the primary session does not stop an owned child's state reports", async () => {
  const f = await fixture();
  await f.create();
  f.state.route = "ses_other";
  await f.start();
  await f.emit("form.created", { form: { sessionID: "ses_child", id: "form_1" } });
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.emit("form.replied", { sessionID: "ses_child", id: "form_1" });
  await f.finish();
  assert.equal(reportStates(f).at(-1), "idle");
  await f.cleanup();
});

test("a replaced terminal is neither reported nor released", async () => {
  const f = await fixture();
  await f.create();
  f.panes.set("w1:p2", { pane_id: "w1:p2", terminal_id: "somebody_else" });
  await f.start();
  await f.advance(1000);
  await f.cleanup();
  assert.equal(f.commands("report-agent").length, 1);
  assert.equal(f.commands("release-agent").length, 0);
  assert.equal(f.commands("close").length, 0);
});

test("unload during launch does not leave report timers behind", async () => {
  const f = await fixture();
  const gate = f.hold("run");
  await f.create();
  const disposed = f.cleanup();
  gate.release();
  await disposed;
  assert.equal(f.timers.size, 0);
  assert.equal(f.commands("report-agent").length, 0);
  assert.equal(f.panes.size, 0);
});

test("failure reports blocked until the error pane closes", async () => {
  const f = await fixture();
  await f.create();
  await f.start();
  await f.finish("ses_child", "failed");
  assert.equal(reportStates(f).at(-1), "blocked");
  await f.advance(5000);
  assert.equal(f.panes.size, 0);
  await f.cleanup();
});

function paneHeights(node, height = 1, result = new Map()) {
  if (node.type === "pane") result.set(node.pane_id, height);
  else {
    assert.equal(node.direction, "down");
    paneHeights(node.first, height * node.ratio, result);
    paneHeights(node.second, height * (1 - node.ratio), result);
  }
  return result;
}

function assertColumn(f, ids, mainPaneWidthPercent = 60) {
  const root = f.state.root;
  assert.equal(root.direction, "right");
  assert.equal(root.first.pane_id, "w1:p1");
  assert.equal(root.ratio, mainPaneWidthPercent / 100);
  const heights = paneHeights(root.second);
  assert.deepEqual([...heights.keys()], ids);
  for (const height of heights.values()) assert.ok(Math.abs(height - 1 / ids.length) < 0.00001);
}

test("three workers form one equal-height column beside a default 60%-width primary", async () => {
  const f = await fixture();
  for (const id of ["ses_a", "ses_b", "ses_c"]) await f.create(id);
  assertColumn(f, ["w1:p2", "w1:p3", "w1:p4"]);
  const splits = f.commands("split").map(({ args }) => [
    args[args.indexOf("--pane") + 1], args[args.indexOf("--direction") + 1],
  ]);
  assert.deepEqual(splits, [["w1:p1", "right"], ["w1:p2", "down"], ["w1:p3", "down"]]);
  for (const { args } of f.commands("layout.set_split_ratio")) {
    assert.equal(JSON.parse(args[2]).path[0], true, "never resize the primary split");
  }
  await f.cleanup();
});

for (const mainPaneWidthPercent of [10, 40, 60, 75, 90]) {
  test(`configured main width ${mainPaneWidthPercent}% is kept as workers open and close`, async () => {
    const f = await fixture({ options: { mainPaneWidthPercent } });
    for (const id of ["ses_a", "ses_b", "ses_c"]) await f.create(id);
    assertColumn(f, ["w1:p2", "w1:p3", "w1:p4"], mainPaneWidthPercent);
    const splits = f.commands("split");
    assert.equal(splits[0].args[splits[0].args.indexOf("--ratio") + 1], String(mainPaneWidthPercent / 100));
    for (const { args } of splits.slice(1)) {
      assert.equal(args[args.indexOf("--direction") + 1], "down");
      assert.equal(args[args.indexOf("--ratio") + 1], "0.5");
    }
    await f.finish("ses_b", "interrupted");
    await f.advance(0);
    assertColumn(f, ["w1:p2", "w1:p4"], mainPaneWidthPercent);
    for (const id of ["ses_a", "ses_c"]) await f.finish(id, "interrupted");
    await f.advance(0);
    assert.equal(f.state.root.pane_id, "w1:p1");
    await f.create("ses_d");
    assertColumn(f, ["w1:p5"], mainPaneWidthPercent);
    await f.cleanup();
  });
}

test("missing or invalid main width options use 60%", async () => {
  for (const mainPaneWidthPercent of [undefined, null, 0, 9, 91, 100, -10, 60.5, "70", true, {}, NaN, Infinity]) {
    const f = await fixture({ options: { mainPaneWidthPercent } });
    await f.create();
    assertColumn(f, ["w1:p2"]);
    await f.cleanup();
  }
});

test("six workers retain equal heights and the primary width", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) await f.create(`ses_${i}`);
  assertColumn(f, ["w1:p2", "w1:p3", "w1:p4", "w1:p5", "w1:p6", "w1:p7"]);
  await f.cleanup();
});

for (const index of [0, 1, 2]) {
  test(`closing worker ${index + 1} balances the remaining column and allows another worker`, async () => {
    const f = await fixture();
    const sessions = ["ses_a", "ses_b", "ses_c"];
    const panes = ["w1:p2", "w1:p3", "w1:p4"];
    for (const id of sessions) await f.create(id);
    await f.finish(sessions[index]);
    await f.advance(2000);
    panes.splice(index, 1);
    assertColumn(f, panes);
    await f.create("ses_d");
    assertColumn(f, [...panes, "w1:p5"]);
    await f.cleanup();
    assert.equal(f.state.root.pane_id, "w1:p1");
  });
}

test("concurrent worker starts preserve their order in one column", async () => {
  const f = await fixture();
  const gate = f.hold("split");
  for (const id of ["ses_a", "ses_b", "ses_c"]) await f.create(id);
  gate.release();
  await flush();
  assertColumn(f, ["w1:p2", "w1:p3", "w1:p4"]);
  await f.cleanup();
});

test("a manually closed bottom worker is not used as a split target", async () => {
  const f = await fixture();
  await f.create("ses_a");
  await f.create("ses_b");
  f.panes.delete("w1:p3");
  await f.create("ses_c");
  assertColumn(f, ["w1:p2", "w1:p4"]);
  await f.cleanup();
});

test("a replaced worker terminal cannot be split or resized", async () => {
  const f = await fixture();
  await f.create("ses_a");
  f.panes.set("w1:p2", { pane_id: "w1:p2", terminal_id: "replacement" });
  await f.create("ses_b");
  assert.equal(f.commands("split").length, 1);
  assert.equal(f.commands("layout.set_split_ratio").length, 0);
  assert.ok(f.warnings.some((message) => message.includes("terminal has changed")));
  await f.cleanup();
});

test("unrelated panes outside the primary subtree are preserved", async () => {
  const f = await fixture();
  f.panes.set("w1:p99", { pane_id: "w1:p99", terminal_id: "unrelated" });
  const unrelated = { type: "pane", pane_id: "w1:p99" };
  f.state.root = { type: "split", direction: "down", ratio: 0.7, first: f.state.root, second: unrelated };
  for (const id of ["ses_a", "ses_b", "ses_c"]) await f.create(id);
  assert.equal(f.state.root.ratio, 0.7);
  assert.deepEqual(f.state.root.second, unrelated);
  assertColumn({ state: { root: f.state.root.first } }, ["w1:p2", "w1:p3", "w1:p4"]);
  await f.cleanup();
  assert.equal(f.panes.size, 1);
});

for (const change of ["moved", "unowned", "horizontal"]) {
  test(`${change} worker layout is not split or rebalanced`, async () => {
    const f = await fixture();
    await f.create("ses_a");
    await f.create("ses_b");
    if (change === "moved") {
      f.state.root = { type: "split", direction: "down", ratio: 0.5,
        first: { ...f.state.root, second: f.state.root.second.first }, second: f.state.root.second.second };
    } else if (change === "unowned") {
      f.panes.set("w1:p99", { pane_id: "w1:p99", terminal_id: "unrelated" });
      f.state.root.second.second = { type: "pane", pane_id: "w1:p99" };
    } else f.state.root.second.direction = "right";
    const before = JSON.stringify(f.state.root);
    await f.create("ses_c");
    assert.equal(f.commands("split").length, 2);
    assert.equal(f.commands("layout.set_split_ratio").length, 0);
    assert.equal(JSON.stringify(f.state.root), before);
    await f.cleanup();
  });
}

test("resize errors do not close workers and a later addition can balance them", async () => {
  const f = await fixture();
  await f.create("ses_a");
  await f.create("ses_b");
  f.override("layout.set_split_ratio", '{"error":{"code":"unavailable"}}');
  await f.create("ses_c");
  assert.equal(f.panes.size, 3);
  assert.equal(f.commands("run").length, 3);
  await f.create("ses_d");
  assertColumn(f, ["w1:p2", "w1:p3", "w1:p4", "w1:p5"]);
  await f.cleanup();
});

test("invalid layout responses cause no split", async () => {
  for (const response of ['not json', '{}', '{"id":"wrong","result":{}}', '{"result":{"layout":{}}}']) {
    const f = await fixture();
    f.override("layout.export", response);
    await f.create();
    assert.equal(f.commands("split").length, 0);
    await f.cleanup();
    assert.equal(f.timers.size, 0);
  }
});

test("a layout request timeout settles and does not disable later launches", async () => {
  const f = await fixture();
  const gate = f.hold("layout.export");
  await f.create();
  await f.advance(5000);
  assert.equal(f.commands("split").length, 0);
  gate.release();
  await f.create("ses_other");
  assert.equal(f.commands("split").length, 1);
  await f.cleanup();
});

test("unload while reading the layout prevents a split", async () => {
  const f = await fixture();
  const gate = f.hold("layout.export");
  await f.create();
  const cleanup = f.cleanup();
  gate.release();
  await cleanup;
  assert.equal(f.commands("split").length, 0);
  assert.equal(f.timers.size, 0);
});

test("all manually closed workers release capacity and a fresh column can open", async () => {
  const f = await fixture({ options: { maxPanes: 2 } });
  await f.create("ses_a");
  await f.create("ses_b");
  f.panes.clear();
  await f.create("ses_c");
  assertColumn(f, ["w1:p4"]);
  const args = f.commands("split").at(-1).args;
  assert.equal(args[args.indexOf("--pane") + 1], "w1:p1");
  assert.equal(args[args.indexOf("--direction") + 1], "right");
  await f.cleanup();
});

test("a split response that repeats an existing worker ID is rejected", async () => {
  const f = await fixture();
  await f.create("ses_a");
  f.override("split", '{"result":{"pane":{"pane_id":"w1:p2","terminal_id":"term_2"}}}');
  await f.create("ses_b");
  assert.equal(f.commands("run").length, 1);
  assert.equal(f.commands("close").length, 0);
  assert.ok(f.warnings.some((message) => message.includes("valid child pane ID")));
  await f.cleanup();
});

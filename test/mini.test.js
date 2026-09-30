import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMini } from "../mini.mjs";
import { readService, serviceFile, serviceReady } from "../service.js";

const flush = () => new Promise((done) => setImmediate(done));
const service = {
  id: "server-first", pid: 1234, version: "2.0.15", url: "http://127.0.0.1:49374", password: "test-secret",
};

async function fixture(options = {}) {
  const controller = new AbortController();
  const state = { service: { ...service }, ready: true, ...options };
  const launches = [];
  const waits = new Set();
  const messages = [];
  const signals = [];
  let resets = 0;
  const result = runMini({
    file: "/fake/service.json", sessionID: "ses_worker", command: options.command ?? ["/fake/opencode-2.0.14"],
    signal: controller.signal,
  }, {
    async readService() {
      if (!state.service) throw new Error("Registration not available");
      return state.service;
    },
    async serviceReady() { return state.ready; },
    spawn(binary, args, settings) {
      assert.equal(launches.filter((item) => !item.exited).length, 0, "only one Mini may own the terminal");
      const child = new EventEmitter();
      const item = { binary, args, settings, child, exited: false };
      child.once("exit", () => { item.exited = true; });
      child.once("error", () => { item.exited = true; });
      child.kill = (signal) => {
        signals.push(signal);
        if (signal !== "SIGTERM" || !state.ignoreTerm) child.emit("exit", null, signal);
      };
      launches.push(item);
      return child;
    },
    wait(ms, signal) {
      return new Promise((resolve) => {
        const item = { ms, done };
        function done() {
          waits.delete(item);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        waits.add(item);
        if (signal?.aborted) done();
        else signal?.addEventListener("abort", done, { once: true });
      });
    },
    env: { PATH: "/fake", OPENCODE_PASSWORD: "stale-password" },
    message: (text) => messages.push(text),
    resetTerminal: () => { resets++; },
  });
  await flush();
  return {
    state, launches, waits, messages, signals, result, controller,
    get resets() { return resets; },
    async tick() { for (const item of [...waits]) item.done(); await flush(); },
    async stop() { controller.abort(); await flush(); return result; },
  };
}

test("an older Mini attaches explicitly with authentication only in its environment", async () => {
  const f = await fixture();
  const launch = f.launches[0];
  assert.equal(launch.binary, "/fake/opencode-2.0.14");
  assert.deepEqual(launch.args, ["mini", "--server", service.url, "--session", "ses_worker"]);
  assert.equal(launch.settings.env.OPENCODE_PASSWORD, service.password);
  assert.equal(launch.settings.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(launch.settings.stdio, "inherit");
  assert.ok(!JSON.stringify(launch.args).includes(service.password));
  await f.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.state.service.pid, service.pid);
  await f.stop();
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(f.waits.size, 0);
});

test("a replacement service reconnects the same session after the old Mini exits", async () => {
  const f = await fixture();
  f.state.service = { ...service, id: "server-second", pid: 2345, url: "http://127.0.0.1:50000", password: "new-secret" };
  await f.tick();
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(f.launches.length, 2);
  assert.deepEqual(f.launches[1].args, ["mini", "--server", f.state.service.url, "--session", "ses_worker"]);
  assert.equal(f.launches[1].settings.env.OPENCODE_PASSWORD, "new-secret");
  await f.tick();
  assert.equal(f.launches.length, 2);
  await f.stop();
});

test("a restart on the same URL and a password rotation both reconnect", async () => {
  const f = await fixture();
  f.state.service = { ...service, id: "server-second", pid: 2345 };
  await f.tick();
  f.state.service = { ...f.state.service, password: "rotated-secret" };
  await f.tick();
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[2].settings.env.OPENCODE_PASSWORD, "rotated-secret");
  await f.stop();
});

test("missing or incomplete registration waits without starting a service", async () => {
  const f = await fixture({ service: undefined });
  await f.tick();
  await f.tick();
  assert.equal(f.launches.length, 0);
  assert.equal(f.messages.length, 1);
  f.state.service = service;
  f.state.ready = false;
  await f.tick();
  assert.equal(f.launches.length, 0);
  f.state.ready = true;
  await f.tick();
  assert.equal(f.launches.length, 1);
  await f.stop();
});

test("a temporary registration gap does not interrupt a running Mini", async () => {
  const f = await fixture();
  f.state.service = undefined;
  await f.tick();
  assert.equal(f.signals.length, 0);
  assert.equal(f.launches.length, 1);
  f.state.service = { ...service, id: "replacement" };
  await f.tick();
  assert.equal(f.launches.length, 2);
  await f.stop();
});

test("Mini can exit during an outage and reconnect when the service returns", async () => {
  const f = await fixture();
  f.state.ready = false;
  f.launches[0].child.emit("exit", 1);
  await f.tick();
  await f.tick();
  assert.equal(f.launches.length, 1);
  f.state.service = { ...service, id: "replacement" };
  f.state.ready = true;
  await f.tick();
  assert.equal(f.launches.length, 2);
  await f.stop();
});

test("normal client exit stays closed while the service is healthy", async () => {
  const f = await fixture();
  f.launches[0].child.emit("exit", 0);
  await f.tick();
  assert.equal(await f.result, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.waits.size, 0);
  assert.equal(f.resets, 1);
});

test("a client startup error exits without a retry loop or secret in its message", async () => {
  const f = await fixture();
  f.launches[0].child.emit("error", new Error(`spawn failed ${service.password}`));
  await f.tick();
  assert.equal(await f.result, 1);
  assert.equal(f.launches.length, 1);
  assert.ok(!f.messages.join(" ").includes(service.password));
});

test("a wrapper receives the parent executable followed by the explicit connection", async () => {
  const f = await fixture({ command: ["/fake/wrapper", "--label", "a ' quoted argument", "/fake/opencode"] });
  assert.equal(f.launches[0].binary, "/fake/wrapper");
  assert.deepEqual(f.launches[0].args, [
    "--label", "a ' quoted argument", "/fake/opencode", "mini", "--server", service.url, "--session", "ses_worker",
  ]);
  await f.stop();
});

test("closing a waiting pane cancels its timer without a client launch", async () => {
  const f = await fixture({ service: undefined });
  assert.equal(await f.stop(), 0);
  assert.equal(f.waits.size, 0);
  assert.equal(f.launches.length, 0);
});

test("an unresponsive Mini is stopped before another client can use the terminal", async () => {
  const f = await fixture({ ignoreTerm: true });
  f.state.service = { ...service, id: "replacement" };
  await f.tick();
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(f.launches.length, 1);
  await f.tick();
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.launches.length, 2);
  f.state.ignoreTerm = false;
  await f.stop();
});

test("service paths follow XDG state and release channels", () => {
  const env = { XDG_STATE_HOME: "/fake/state" };
  for (const channel of ["latest", "dev", "beta", "next"]) {
    assert.equal(serviceFile(channel, env), "/fake/state/opencode/service.json");
  }
  assert.equal(serviceFile("local", env), "/fake/state/opencode/service-local.json");
  assert.equal(serviceFile("test/branch", env), "/fake/state/opencode/service-test-branch.json");
});

test("registration parsing accepts local services and rejects incomplete or remote entries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "service.json");
  await assert.rejects(readService(file));
  await writeFile(file, "{");
  await assert.rejects(readService(file));
  for (const change of [{}, { url: "http://localhost:1234" }, { url: "http://[::1]:1234" }]) {
    await writeFile(file, JSON.stringify({ ...service, ...change }));
    assert.equal((await readService(file)).id, service.id);
  }
  for (const change of [
    { url: "https://example.com" }, { url: "http://127.0.0.1:1234/path" },
    { url: "http://user:pass@localhost:1234" }, { url: "http://localhost:1234?query" },
    { pid: 1 }, { pid: "1234" }, { password: "" }, { id: undefined },
  ]) {
    await writeFile(file, JSON.stringify({ ...service, ...change }));
    await assert.rejects(readService(file));
  }
});

test("health checks authenticate and require the registered PID and version", async (t) => {
  let status = 200;
  let info = { pid: service.pid, version: service.version };
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/info");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`);
    response.writeHead(status);
    response.end(JSON.stringify(info));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const target = { ...service, url: `http://127.0.0.1:${server.address().port}` };
  assert.equal(await serviceReady(target), true);
  info = { ...info, pid: 5678 };
  assert.equal(await serviceReady(target), false);
  info = { pid: service.pid, version: "2.0.14" };
  assert.equal(await serviceReady(target), false);
  status = 401;
  assert.equal(await serviceReady(target), false);
});

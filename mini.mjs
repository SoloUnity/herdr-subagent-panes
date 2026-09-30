import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readService, sameService, serviceReady } from "./service.js";

const wait = (ms, signal) => delay(ms, undefined, { signal }).catch((error) => {
  if (error.name !== "AbortError") throw error;
});

export async function runMini({ file, sessionID, command, signal }, dependencies = {}) {
  const io = {
    readService, serviceReady, spawn, wait,
    env: process.env,
    message: (text) => console.error(text),
    resetTerminal: () => { if (process.stdin.isTTY) process.stdin.setRawMode(false); },
    ...dependencies,
  };
  let active;
  let waiting = false;

  const registration = () => io.readService(file).catch(() => undefined);
  const pause = async () => {
    if (!waiting) io.message("Waiting for the OpenCode service. Press Ctrl+C to close this client.");
    waiting = true;
    await io.wait(1_000, signal);
  };
  const stop = async () => {
    if (!active) return;
    if (!active.result) {
      active.child.kill("SIGTERM");
      const timeout = new AbortController();
      await Promise.race([active.closed, io.wait(2_000, timeout.signal)]);
      timeout.abort();
      if (!active.result) active.child.kill("SIGKILL");
      await active.closed;
    }
    io.resetTerminal();
    active = undefined;
  };

  try {
    while (!signal.aborted) {
      const service = await registration();
      if (signal.aborted) break;
      if (active) {
        if (service && !sameService(service, active.service)) {
          await stop();
        } else if (active.result) {
          // A normal user exit must not reopen Mini. A service outage must.
          if (service && await io.serviceReady(service)) return active.result.code ?? 1;
          await stop();
        } else {
          await io.wait(1_000, signal);
          continue;
        }
      }
      if (!service || !await io.serviceReady(service)) {
        await pause();
        continue;
      }
      if (signal.aborted) break;
      waiting = false;
      const [binary, ...prefix] = command;
      const child = io.spawn(binary, [...prefix, "mini", "--server", service.url, "--session", sessionID], {
        stdio: "inherit",
        env: { ...io.env, OPENCODE_PASSWORD: service.password },
      });
      const launched = { child, service, result: undefined };
      launched.closed = new Promise((done) => {
        child.once("error", () => {
          launched.result = { code: 1 };
          io.message("Could not start the OpenCode Mini client.");
          done();
        });
        child.once("exit", (code) => {
          launched.result = { code };
          done();
        });
      });
      active = launched;
      await io.wait(1_000, signal);
    }
    return 0;
  } finally {
    await stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, sessionID, ...command] = process.argv.slice(2);
  if (!file || !sessionID?.startsWith("ses") || !command.length) {
    console.error("Usage: node mini.mjs <service-file> <session-id> <executable> [prefix arguments]");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
    try {
      process.exitCode = await runMini({ file, sessionID, command, signal: controller.signal });
    } catch {
      console.error("The OpenCode Mini client stopped unexpectedly.");
      process.exitCode = 1;
    } finally {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop);
    }
  }
}

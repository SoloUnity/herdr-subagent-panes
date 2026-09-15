import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestLayout, workerStack } from "./layout.js";

const execFileAsync = promisify(execFile);
const CHILD_PANE_ENV = "OPENCODE_HERDR_SUBAGENT_PANE";
const CLOSE_ATTEMPTS = 3;
const CLOSE_RETRY_MS = 1_000;
const REPORT_SOURCE = "herdr:opencode-subagent-panes";
const REPORT_RETRY_MS = 500;

function isPaneID(value) {
  return typeof value === "string" && /^w[\w-]+:p[\w-]+$/.test(value);
}

function isMissingPane(error) {
  return error.code === "not_found" || error.code === "pane_not_found";
}

function integerOption(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function runHerdr(args, requireJson = false) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("herdr", args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (cause) {
    // Herdr 0.9 writes API errors to stderr and exits with status 1.
    let code;
    try {
      code = JSON.parse(cause.stderr).error?.code;
    } catch {}
    const error = new Error(`Herdr ${args[1]} failed${code ? ` (${code})` : ""}`);
    error.code = code;
    throw error;
  }
  // Inspect and layout commands print one JSON document. `pane run` is silent.
  if (!requireJson && !stdout.trim()) return;
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("Herdr returned an invalid JSON response");
  }
  if (response?.error) {
    const error = new Error(`Herdr ${args[1]} failed (${response.error.code})`);
    error.code = response.error.code;
    throw error;
  }
  if (!response?.result || typeof response.result !== "object") {
    throw new Error("Herdr returned no result");
  }
  return response.result;
}

async function resolveCommandPrefix(value = []) {
  if (
    !Array.isArray(value) ||
    value.some((arg) => typeof arg !== "string" || !arg.trim() || /[\0\r\n]/.test(arg)) ||
    value[0]?.startsWith("-")
  ) {
    throw new Error("commandPrefix must be an array of nonempty arguments, starting with an executable");
  }
  if (value.length === 0) return "";
  const { stdout } = await execFileAsync("which", [value[0]], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const binary = stdout.trim().split("\n")[0];
  if (!binary) throw new Error("The commandPrefix executable is not on PATH");
  return `${[binary, ...value.slice(1)].map(shellQuote).join(" ")} `;
}

async function parentProcessInfo(paneID) {
  const result = await runHerdr(["pane", "process-info", "--pane", paneID], true);
  const info = result.process_info;
  if (info?.pane_id !== paneID || !Number.isInteger(info.shell_pid) || info.shell_pid <= 1) {
    throw new Error("Cannot verify the parent Herdr pane");
  }
  return info;
}

async function verifyAncestry(shellPID) {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  const parents = new Map(stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)));
  const seen = new Set();
  for (let pid = process.pid; pid > 1 && !seen.has(pid); pid = parents.get(pid)) {
    if (pid === shellPID) return;
    seen.add(pid);
  }
  throw new Error("This process does not belong to the specified Herdr pane");
}

export default {
  id: "herdr.opencode.subagent-panes",
  async setup(context) {
    const parentPaneID = process.env.HERDR_PANE_ID;
    if (
      process.env.HERDR_ENV !== "1" ||
      !isPaneID(parentPaneID) ||
      !process.env.HERDR_SOCKET_PATH ||
      process.env[CHILD_PANE_ENV] === "1"
    ) {
      return;
    }

    const maxPanes = integerOption(context.options?.maxPanes, 6, 1, 20);
    const mainPaneWidthPercent = integerOption(context.options?.mainPaneWidthPercent, 60, 10, 90);
    const autoCloseDelayMs = integerOption(
      context.options?.autoCloseDelayMs,
      2_000,
      0,
      60_000,
    );
    const children = new Map();
    const unsubscribers = [];
    let disposed = false;
    let openingDisabled = false;
    let warned = false;
    let layoutQueue = Promise.resolve();
    let commandPrefix;
    let parentShellPID;
    let reportSequence = Date.now() * 1000;

    const warn = (message) => {
      console.warn(`herdr-subagent-panes: ${message}`);
      if (warned || disposed) return;
      warned = true;
      try {
        context.ui.toast.show({
          title: "Herdr subagent panes",
          message,
          variant: "warning",
          duration: 5_000,
        });
      } catch {
        // A terminal notification must not stop session processing.
      }
    };

    // V2 does not expose the connected endpoint and its credentials to plugins.
    // Do not silently attach Mini to the shared service for a private connection.
    if (process.argv.some((arg) => /^--(?:server|standalone)(?:=|$)/.test(arg))) {
      warn("Disabled: subagent panes require the local shared OpenCode service");
      return;
    }
    try {
      parentShellPID = (await parentProcessInfo(parentPaneID)).shell_pid;
      await verifyAncestry(parentShellPID);
      commandPrefix = await resolveCommandPrefix(context.options?.commandPrefix);
    } catch (error) {
      warn(`Disabled: ${error.message}`);
      return;
    }

    const enqueue = (operation) => {
      layoutQueue = layoutQueue.then(operation).catch((error) => warn(error.message));
      return layoutQueue;
    };

    const ownedRootSessions = () => {
      const sessionIDs = new Set(
        context.ui.tabs.enabled() ? context.ui.tabs.list().map((tab) => tab.sessionID) : [],
      );
      const route = context.ui.router.current();
      if (route.type === "session" && route.sessionID !== "dummy") {
        sessionIDs.add(route.sessionID);
      }
      return sessionIDs;
    };

    const ownsParent = (parentID) => {
      try {
        const owned = ownedRootSessions();
        if (owned.has(parentID)) return true;
        return owned.has(context.data.session.root(parentID));
      } catch {
        return false;
      }
    };

    const cancelClose = (child) => {
      clearTimeout(child.close?.timer);
      child.close = undefined;
    };

    const cancelReportTimers = (child) => {
      clearTimeout(child.reportRetry);
      clearTimeout(child.startupReport);
      child.reportRetry = undefined;
      child.startupReport = undefined;
    };

    const forgetPane = (child) => {
      child.pane = undefined;
      child.ready = false;
      child.lastReport = undefined;
      cancelReportTimers(child);
    };

    const inspectWorkers = async () => {
      if ((await parentProcessInfo(parentPaneID)).shell_pid !== parentShellPID) {
        throw new Error("The parent Herdr terminal has changed");
      }
      const ownedIDs = new Set();
      for (const child of children.values()) {
        if (!child.pane) continue;
        try {
          const current = (await runHerdr(["pane", "get", child.pane.pane_id], true)).pane;
          if (!child.pane.terminal_id || current?.terminal_id !== child.pane.terminal_id) {
            throw new Error("A worker terminal has changed; layout left unchanged");
          }
          ownedIDs.add(child.pane.pane_id);
        } catch (error) {
          if (!isMissingPane(error)) throw error;
          forgetPane(child);
        }
      }
      const { layout } = await requestLayout("layout.export", { pane_id: parentPaneID });
      if (!layout?.tab_id) throw new Error("Herdr returned an invalid layout");
      return { ...workerStack(layout.root, parentPaneID, ownedIDs), tabID: layout.tab_id };
    };

    const balanceWorkers = async (allowed = () => !disposed) => {
      try {
        // Read identities and paths again before every change. A user can move
        // or close a pane between our serialized operations.
        for (let i = 0; i < maxPanes && allowed(); i++) {
          const stack = await inspectWorkers();
          const split = stack.splits.find((item) => Math.abs(item.ratio - item.target) > 0.00001);
          if (!split || !allowed()) return;
          await requestLayout("layout.set_split_ratio", {
            tab_id: stack.tabID, path: split.path, ratio: split.target,
          });
        }
      } catch (error) {
        // A resize failure must not close a running worker or stop cleanup.
        warn(`Could not balance worker panes: ${error.message}`);
      }
    };

    // Events can arrive before cache updates. Keep each request delta until
    // the cache agrees, so a late snapshot cannot undo an ask or a reply.
    const reportedState = (child) => {
      // Pending-request caches may lag behind an interruption.
      if (child.stopped) return "idle";
      for (const kind of ["permission", "form"]) {
        const items = context.data.session[kind].list(child.sessionID);
        if (items === undefined) continue;
        for (const key of child.blockers) {
          if (key.startsWith(`${kind}:`)) child.blockers.delete(key);
        }
        for (const item of items) child.blockers.add(`${kind}:${item.id}`);
        for (const [key, present] of child.blockerChanges) {
          if (key.startsWith(`${kind}:`) && child.blockers.has(key) === present) {
            child.blockerChanges.delete(key);
          }
        }
      }
      for (const [key, present] of child.blockerChanges) {
        if (present) child.blockers.add(key);
        else child.blockers.delete(key);
      }
      return child.blockers.size ? "blocked" : child.state;
    };

    // Use the same queue as pane creation/closure. Read the latest state at
    // dispatch, and never send a report to a replaced terminal or the parent.
    const reportChild = (child, force = false) => {
      if (force) child.lastReport = undefined;
      if (disposed || !child.ready || child.reportPending) return;
      child.reportPending = true;
      void enqueue(async () => {
        child.reportPending = false;
        const pane = child.pane;
        if (disposed || !pane || !child.ready || children.get(child.sessionID) !== child) return;
        let sent;
        try {
          if (child.lastReport === reportedState(child)) return;
          const current = (await runHerdr(["pane", "get", pane.pane_id], true)).pane;
          if (current?.terminal_id !== pane.terminal_id) return;
          if (disposed || child.pane !== pane) return;
          sent = reportedState(child);
          await runHerdr([
            "pane", "report-agent", pane.pane_id,
            "--source", REPORT_SOURCE, "--agent", "opencode",
            "--state", sent, "--agent-session-id", child.sessionID,
            "--seq", String(++reportSequence),
          ]);
          child.lastReport = sent;
          clearTimeout(child.reportRetry);
          child.reportRetry = undefined;
        } catch (error) {
          if (isMissingPane(error) || disposed) return;
          warn(`Could not report pane ${pane.pane_id}: ${error.message}`);
          if (!child.reportRetry) {
            child.reportRetry = setTimeout(() => {
              child.reportRetry = undefined;
              reportChild(child);
            }, REPORT_RETRY_MS);
          }
          return;
        }
        if (!disposed && reportedState(child) !== sent) reportChild(child);
      });
    };

    const changeBlocker = (sessionID, kind, requestID, present) => {
      const child = children.get(sessionID);
      if (!child || typeof requestID !== "string") return;
      child.blockerChanges.set(`${kind}:${requestID}`, present);
      reportChild(child);
    };

    const removePane = async (child, allowed = () => true) => {
      const pane = child.pane;
      if (!pane) return;
      try {
        const current = (await runHerdr(["pane", "get", pane.pane_id], true)).pane;
        if (!current?.terminal_id || !pane.terminal_id) {
          throw new Error("Cannot verify the child terminal identity");
        }
        if (current.terminal_id !== pane.terminal_id) {
          warn(`Pane ${pane.pane_id} has a different terminal; left it unchanged`);
        } else {
          if (!allowed()) return;
          await runHerdr([
            "pane", "release-agent", pane.pane_id,
            "--source", REPORT_SOURCE, "--agent", "opencode",
            "--seq", String(++reportSequence),
          ]).catch((error) => warn(`Could not release pane ${pane.pane_id}: ${error.message}`));
          child.lastReport = undefined;
          if (!allowed()) {
            reportChild(child);
            return;
          }
          await runHerdr(["pane", "close", pane.pane_id], true);
        }
      } catch (error) {
        if (!isMissingPane(error)) throw error;
      }
      forgetPane(child);
      if (!disposed) await balanceWorkers(allowed);
    };

    const closeChild = (sessionID, delay = autoCloseDelayMs, replace = false) => {
      const child = children.get(sessionID);
      if (!child || disposed || (child.close && !replace)) return;
      cancelClose(child);
      const request = { timer: undefined, attempts: 0 };
      child.close = request;
      const current = () => !disposed && child.close === request && children.get(sessionID) === child;
      const schedule = (wait) => {
        request.timer = setTimeout(() => {
          request.timer = undefined;
          void enqueue(async () => {
            if (!current()) return;
            request.attempts += 1;
            try {
              await removePane(child, current);
              if (current() && !child.pane) children.delete(sessionID);
            } catch (error) {
              warn(`Could not close pane ${child.pane?.pane_id}: ${error.message}`);
              if (current() && request.attempts < CLOSE_ATTEMPTS) schedule(CLOSE_RETRY_MS);
            }
          });
        }, wait);
      };
      schedule(delay);
    };

    const openChild = (child) => {
      void enqueue(async () => {
        const { sessionID } = child;
        const needed = () => !disposed && !child.close && children.get(sessionID) === child;
        if (!needed() || (child.pane && child.ready)) return;
        if (openingDisabled) {
          if (!child.pane) children.delete(sessionID);
          return;
        }
        // Never send a second shell command into a possibly running Mini.
        if (child.pane) {
          try {
            await removePane(child, needed);
          } catch (error) {
            warn(`Could not replace pane ${child.pane.pane_id}: ${error.message}`);
            closeChild(sessionID, 0, true);
            return;
          }
          if (!needed() || child.pane) return;
        }
        let splitAttempted = false;
        try {
          let info = context.data.session.get(sessionID);
          if (!info?.location?.directory) {
            await context.data.session.sync(sessionID);
            info = context.data.session.get(sessionID);
          }
          if (!info?.parentID || !ownsParent(info.parentID)) {
            cancelClose(child);
            children.delete(sessionID);
            return;
          }
          if (!info.location?.directory) throw new Error("The child session location is unavailable");
          const stack = await inspectWorkers();
          if (stack.workers.length >= maxPanes) {
            children.delete(sessionID);
            warn(`Pane limit (${maxPanes}) reached; skipped ${sessionID}`);
            return;
          }
          if (!needed()) return;
          // Create the right column once; append later workers below its last
          // verified pane. Never split an unowned or moved worker terminal.
          const target = stack.workers.at(-1) ?? parentPaneID;
          splitAttempted = true;
          const response = await runHerdr([
            "pane",
            "split",
            "--pane",
            target,
            "--direction",
            stack.workers.length ? "down" : "right",
            "--ratio",
            stack.workers.length ? "0.5" : String(mainPaneWidthPercent / 100),
            "--cwd",
            info.location.directory,
            "--env",
            `${CHILD_PANE_ENV}=1`,
            "--env",
            "HERDR_AGENT=opencode",
            "--no-focus",
          ], true);
          const pane = response.pane;
          if (!isPaneID(pane?.pane_id) || pane.pane_id === parentPaneID || stack.workers.includes(pane.pane_id)) {
            throw new Error("Herdr did not return a valid child pane ID");
          }
          child.pane = pane;
          if (!pane.terminal_id) throw new Error("Herdr did not return a terminal identity");
          if (disposed || child.stopped) return;

          await balanceWorkers(needed);
          if (disposed || child.stopped) return;

          const label = `subagent: ${info.agent ?? sessionID.slice(-8)}`;
          await runHerdr(["pane", "rename", pane.pane_id, label.slice(0, 64)]).catch(() => {});
          if (disposed || child.stopped) return;
          const command = `${commandPrefix}opencode2 mini --session ${shellQuote(sessionID)}`;
          await runHerdr(["pane", "run", pane.pane_id, command]);
          if (disposed || child.stopped) return;
          child.ready = true;
          reportChild(child);
          // Process detection can reset an early report during shell startup.
          child.startupReport = setTimeout(() => {
            child.startupReport = undefined;
            reportChild(child, true);
          }, 1_000);
          void Promise.all([
            context.data.session.permission.sync(sessionID),
            context.data.session.form.sync(sessionID),
          ]).then(() => reportChild(child)).catch((error) => {
            if (!disposed) warn(`Could not read pending requests for ${sessionID}: ${error.message}`);
          });
        } catch (error) {
          warn(`Could not open a subagent pane: ${error.message}`);
          if (splitAttempted && !child.pane && !error.code) {
            // A timed-out split may have succeeded. Do not repeat it blindly.
            openingDisabled = true;
            warn("Pane creation stopped: the split result is unknown. Inspect Herdr before reloading this plugin");
          }
          if (child.pane) closeChild(sessionID, 0, true);
          else if (children.get(sessionID) === child) {
            cancelClose(child);
            children.delete(sessionID);
          }
        }
      });
    };

    const startChild = (event, created = false) => {
      if (disposed) return;
      const sessionID = event.data?.sessionID;
      if (typeof sessionID !== "string" || !sessionID.startsWith("ses")) return;
      let child = children.get(sessionID);
      if (created && child) return;
      // A tracked execution can restart after the user switches to another tab.
      if (child) {
        cancelClose(child);
        child.stopped = false;
        child.state = "working";
        reportChild(child);
        openChild(child);
        return;
      }
      const parentID = context.data.session.get(sessionID)?.parentID ?? event.data?.parentID;
      if (!parentID || !ownsParent(parentID)) return;
      if (!child) {
        child = {
          sessionID, pane: undefined, ready: false, close: undefined, stopped: false,
          state: !created || context.data.session.status(sessionID) === "running" ? "working" : "idle",
          blockers: new Set(), blockerChanges: new Map(),
          reportPending: false, lastReport: undefined,
          reportRetry: undefined, startupReport: undefined,
        };
        children.set(sessionID, child);
      }
      cancelClose(child);
      openChild(child);
    };

    const finishChild = (event, failed = false) => {
      const child = children.get(event.data?.sessionID);
      if (!child || child.stopped) return;
      child.state = failed ? "blocked" : "idle";
      reportChild(child);
      closeChild(child.sessionID, failed ? Math.max(autoCloseDelayMs, 5_000) : autoCloseDelayMs);
    };

    const stopChild = (event) => {
      const child = children.get(event.data?.sessionID);
      if (!child || child.stopped || disposed) return;
      child.stopped = true;
      child.state = "idle";
      reportChild(child);
      // Main TUI and Mini stops use the same service event. Replace any
      // success/failure delay, but retain identity checks and close retries.
      closeChild(child.sessionID, 0, true);
    };

    unsubscribers.push(
      context.data.on("session.created", (event) => startChild(event, true)),
      context.data.on("session.execution.started", (event) => startChild(event)),
      context.data.on("session.execution.succeeded", (event) => finishChild(event)),
      context.data.on("session.execution.interrupted", stopChild),
      context.data.on("session.execution.failed", (event) => finishChild(event, true)),
      context.data.on("permission.asked", ({ data }) => changeBlocker(data.sessionID, "permission", data.id, true)),
      context.data.on("permission.replied", ({ data }) => changeBlocker(data.sessionID, "permission", data.requestID, false)),
      context.data.on("form.created", ({ data }) => changeBlocker(data.form.sessionID, "form", data.form.id, true)),
      context.data.on("form.replied", ({ data }) => changeBlocker(data.sessionID, "form", data.id, false)),
      context.data.on("form.cancelled", ({ data }) => changeBlocker(data.sessionID, "form", data.id, false)),
      context.data.on("session.deleted", (event) => {
        closeChild(event.data?.sessionID, 0, true);
      }),
    );

    return async () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const child of children.values()) {
        cancelClose(child);
        cancelReportTimers(child);
      }
      await enqueue(async () => {
        for (const [sessionID, child] of children) {
          try {
            await removePane(child);
            children.delete(sessionID);
          } catch (error) {
            warn(`Pane ${child.pane?.pane_id} remains open; close it manually. ${error.message}`);
          }
        }
      });
    };
  },
};

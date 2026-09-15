import net from "node:net";

// The CLI does not expose layout.export or layout.set_split_ratio in Herdr 0.9.
export function requestLayout(method, params) {
  return new Promise((resolve, reject) => {
    const path = process.env.HERDR_SOCKET_PATH;
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
    const id = `opencode:worker-layout:${Date.now()}:${Math.random()}`;
    let buffer = "";
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const socket = net.createConnection(endpoint, () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), 5_000);
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error(`Herdr ${method} ended without a response`)));
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error("Herdr layout response is too large"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.id !== id) throw new Error("Herdr layout response ID does not match");
        if (response.error) {
          throw Object.assign(new Error(`Herdr ${method} failed (${response.error.code})`), {
            code: response.error.code,
          });
        }
        if (!response.result || typeof response.result !== "object") throw new Error("Herdr returned no layout result");
        finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

// Find only the subtree belonging to this primary and these worker panes.
// Other panes outside that subtree are never resized or moved.
export function workerStack(root, parentID, ownedIDs) {
  const find = (node, path = []) => {
    if (node?.type === "pane" && node.pane_id === parentID) return { node, path };
    if (node?.type !== "split") return;
    if (node.direction === "right" && node.first?.type === "pane" && node.first.pane_id === parentID) {
      return { node, path };
    }
    return find(node.first, [...path, false]) ?? find(node.second, [...path, true]);
  };
  const found = find(root);
  if (!found) throw new Error("The primary pane is missing from the layout");
  if (ownedIDs.size === 0) return { workers: [], splits: [] };
  const workers = [];
  const splits = [];
  const visit = (node, path) => {
    if (node?.type === "pane" && ownedIDs.has(node.pane_id) && !workers.includes(node.pane_id)) {
      workers.push(node.pane_id);
      return 1;
    }
    if (node?.type !== "split" || node.direction !== "down" || !Number.isFinite(node.ratio)) {
      throw new Error("The worker column has changed; layout left unchanged");
    }
    const first = visit(node.first, [...path, false]);
    const second = visit(node.second, [...path, true]);
    splits.push({ path, ratio: node.ratio, target: Math.max(0.1, Math.min(0.9, first / (first + second))) });
    return first + second;
  };
  if (found.node.type !== "split" || found.node.direction !== "right") {
    throw new Error("The worker column is no longer beside the primary pane");
  }
  visit(found.node.second, [...found.path, true]);
  if (workers.length !== ownedIDs.size) throw new Error("A worker pane has moved outside its column");
  return { workers, splits };
}

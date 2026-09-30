import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function serviceFile(channel = "latest", env = process.env) {
  const name = ["latest", "dev", "beta", "next"].includes(channel)
    ? "service.json"
    : `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", name);
}

export async function readService(file) {
  const service = JSON.parse(await readFile(file, "utf8"));
  const url = new URL(service.url);
  if (typeof service.id !== "string" || !service.id || typeof service.version !== "string" ||
      !Number.isInteger(service.pid) || service.pid <= 1 ||
      typeof service.password !== "string" || !service.password ||
      url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid local OpenCode service registration");
  }
  return service;
}

export function sameService(first, second) {
  return first?.id === second?.id && first?.pid === second?.pid &&
    first?.url === second?.url && first?.password === second?.password;
}

export async function serviceReady(service) {
  try {
    const response = await fetch(new URL("/api/info", service.url), {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const info = await response.json();
    return info.pid === service.pid && info.version === service.version;
  } catch {
    return false;
  }
}

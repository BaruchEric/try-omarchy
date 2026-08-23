#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFullGuestServer } from "./serve-full-guest.mjs";
import { verifyRuntimeArtifacts } from "./verify-runtime-artifacts.mjs";

const runtimeDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const BROWSER_QEMU_HOST = "127.0.0.1";
export const BROWSER_QEMU_PORT = 8094;
export const BROWSER_QEMU_PATH = "/web/full-guest.html";
export const DEFAULT_BROWSER_QEMU_PATHS = Object.freeze({
  runtimeRoot: resolve(runtimeDirectory, "dist"),
  guestRoot: resolve(runtimeDirectory, "../guest/dist"),
  webRoot: resolve(runtimeDirectory, "web"),
});

async function requireDirectory(path, label, recovery) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing at ${path}. ${recovery}`);
    }
    throw new Error(`${label} cannot be inspected at ${path}: ${error.message}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory at ${path}. ${recovery}`);
  }
}

function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function createBrowserQemuServer({
  runtimeRoot = DEFAULT_BROWSER_QEMU_PATHS.runtimeRoot,
  guestRoot = DEFAULT_BROWSER_QEMU_PATHS.guestRoot,
  webRoot = DEFAULT_BROWSER_QEMU_PATHS.webRoot,
  verifyRuntime = verifyRuntimeArtifacts,
  serverFactory = createFullGuestServer,
} = {}) {
  const paths = {
    runtimeRoot: resolve(runtimeRoot),
    guestRoot: resolve(guestRoot),
    webRoot: resolve(webRoot),
  };
  await requireDirectory(
    paths.runtimeRoot,
    "Canonical browser QEMU runtime",
    "Run `make -C runtime build` and `make -C runtime package GUEST_DIR=../guest/dist`.",
  );
  await requireDirectory(
    paths.guestRoot,
    "x86_64 Omarchy guest bundle",
    "Build or restore `guest/dist` before launching the browser VM.",
  );
  await requireDirectory(
    paths.webRoot,
    "Browser QEMU web harness",
    "Restore the tracked `runtime/web` files.",
  );

  try {
    await verifyRuntime(paths.runtimeRoot, { writeReport: false, canonical: true });
  } catch (error) {
    throw new Error(
      `Canonical browser QEMU runtime is invalid at ${paths.runtimeRoot}: ${reason(error)}. ` +
        "Rebuild and package `runtime/dist` before retrying.",
    );
  }

  try {
    return await serverFactory(paths);
  } catch (error) {
    throw new Error(
      `Packaged browser QEMU runtime or x86_64 guest bundle is invalid: ${reason(error)}. ` +
        "Rebuild/package the named bundle before retrying.",
    );
  }
}

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function runBrowserQemu({
  host = BROWSER_QEMU_HOST,
  port = BROWSER_QEMU_PORT,
  output = process.stdout,
  ...serverOptions
} = {}) {
  if (host !== BROWSER_QEMU_HOST) {
    throw new Error(`Browser QEMU must bind to ${BROWSER_QEMU_HOST}.`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Browser QEMU port must be an integer between 0 and 65535.");
  }
  const server = await createBrowserQemuServer(serverOptions);
  try {
    await listen(server, port, host);
  } catch (error) {
    server.close();
    throw new Error(`Browser QEMU could not listen on ${host}:${port}: ${reason(error)}`);
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}${BROWSER_QEMU_PATH}`;
  output.write(`OMARCHY_BROWSER_QEMU_URL ${url}\n`);
  return Object.freeze({ server, url });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runBrowserQemu();
  } catch (error) {
    process.stderr.write(`[browser-qemu] ${reason(error)}\n`);
    process.exitCode = 1;
  }
}

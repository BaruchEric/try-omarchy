#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CdpConnection, createPageConnection, evaluate } from "./cdp.mjs";
import { inspectScreenshotPng } from "./png.mjs";
import {
  close,
  createAcceptanceProxy,
  listen,
  waitForRequestIdle,
} from "./server.mjs";

const DEFAULT_BROWSER_PATHS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000 + 60 * 1000;

function usage() {
  return `Usage: node proofs/browser-acceptance/run.mjs \\
  --release-base http://127.0.0.1:8094/release/ \\
  [--browser-executable /path/to/Chromium] \\
  [--output proofs/browser-acceptance/evidence/<run>] \\
  [--timeout-ms ${DEFAULT_RUN_TIMEOUT_MS}]\n`;
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") return { help: true };
    if (!["--release-base", "--browser-executable", "--output", "--timeout-ms"].includes(name)) {
      throw new TypeError(`Unknown argument: ${name}\n${usage()}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value.`);
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  if (!options.release_base) throw new TypeError(`--release-base is required.\n${usage()}`);
  const timeoutMs = options.timeout_ms === undefined ? DEFAULT_RUN_TIMEOUT_MS : Number(options.timeout_ms);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 3_700_000) {
    throw new TypeError("--timeout-ms must be an integer from 60000 through 3700000.");
  }
  return {
    help: false,
    releaseBaseUrl: options.release_base,
    browserExecutable: options.browser_executable,
    output: options.output,
    timeoutMs,
  };
}

async function existingPath(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next explicit Chromium-family location.
    }
  }
  return null;
}

export async function resolveBrowserExecutable(requested) {
  if (requested) {
    const absolute = resolve(requested);
    await access(absolute);
    return absolute;
  }
  const discovered = await existingPath(DEFAULT_BROWSER_PATHS);
  if (!discovered) {
    throw new Error("No Chromium-family browser was found; pass --browser-executable explicitly.");
  }
  return discovered;
}

function waitForDevtools(child, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser did not expose DevTools within ${timeoutMs}ms.\n${stderr.slice(-4000)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (!match) return;
      cleanup();
      resolvePromise({ webSocketUrl: match[1], stderr });
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Browser exited before DevTools was ready (${code ?? signal}).\n${stderr.slice(-4000)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function launchBrowser(executable, profile) {
  const child = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-renderer-backgrounding",
    "--force-device-scale-factor=1",
    "--window-size=1600,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const devtools = await waitForDevtools(child);
    return { child, ...devtools };
  } catch (error) {
    await waitForExit(child);
    throw error;
  }
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForAcceptance(page, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    last = await evaluate(
      page,
      "globalThis.__omarchyBrowserAcceptance?.snapshot?.() ?? null",
    );
    if (last?.stage === "passed") return last;
    if (last?.stage === "failed") {
      throw Object.assign(new Error(last.failure?.reason ?? "Browser acceptance failed."), {
        acceptanceSnapshot: last,
      });
    }
    await delay(500);
  }
  throw Object.assign(new Error(`Browser acceptance exceeded the outer ${timeoutMs}ms timeout.`), {
    acceptanceSnapshot: last,
  });
}

function hashFileBody(body) {
  return { bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
}

async function captureScreenshot(page, hideStatus) {
  if (hideStatus) {
    await evaluate(page, "document.querySelector('#status').style.display = 'none'; new Promise(requestAnimationFrame)");
  }
  const capture = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(capture.data, "base64");
}

async function persistEvidence(output, {
  evidence,
  screenshot,
  screenshotInspection,
  requests,
  manifestBody,
  releaseId,
  worker,
  rootfs,
  acceptanceSourceHashes,
}) {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  const manifestPath = join(output, "artifact-manifest.json");
  const evidencePath = join(output, "evidence.json");
  const requestsPath = join(output, "requests.json");
  const screenshotPath = join(output, "desktop.png");
  const hashesPath = join(output, "hashes.json");
  const sumsPath = join(output, "SHA256SUMS");

  await writeFile(manifestPath, manifestBody);
  const evidenceBody = Buffer.from(`${JSON.stringify({ ...evidence, screenshot: screenshotInspection }, null, 2)}\n`);
  const requestsBody = Buffer.from(`${JSON.stringify(requests, null, 2)}\n`);
  await writeFile(evidencePath, evidenceBody);
  await writeFile(requestsPath, requestsBody);
  if (screenshot) await writeFile(screenshotPath, screenshot);

  const outputs = {
    "artifact-manifest.json": hashFileBody(manifestBody),
    "evidence.json": hashFileBody(evidenceBody),
    "requests.json": hashFileBody(requestsBody),
    ...(screenshot ? { "desktop.png": hashFileBody(screenshot) } : {}),
  };
  const hashes = {
    schemaVersion: 1,
    release: {
      artifactManifestSha256: releaseId,
      productionWorker: { path: worker.path, bytes: worker.bytes, sha256: worker.sha256 },
      rootfs: { path: rootfs.path, bytes: rootfs.bytes, sha256: rootfs.sha256 },
    },
    acceptanceSources: acceptanceSourceHashes,
    outputs,
  };
  const hashesBody = Buffer.from(`${JSON.stringify(hashes, null, 2)}\n`);
  await writeFile(hashesPath, hashesBody);
  const sums = {
    ...outputs,
    "hashes.json": hashFileBody(hashesBody),
  };
  await writeFile(
    sumsPath,
    `${Object.entries(sums).map(([name, { sha256 }]) => `${sha256}  ${name}`).join("\n")}\n`,
  );
  return { output, files: [...Object.keys(sums), "SHA256SUMS"] };
}

function defaultOutput() {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
  return resolve("proofs/browser-acceptance/evidence", `${timestamp}-${process.pid}`);
}

export async function runAcceptance(options) {
  const output = resolve(options.output ?? defaultOutput());
  const browserExecutable = await resolveBrowserExecutable(options.browserExecutable);
  const proxy = await createAcceptanceProxy({ releaseBaseUrl: options.releaseBaseUrl });
  const proxyOrigin = await listen(proxy.server);
  const profile = await mkdtemp(join(tmpdir(), "omarchy-browser-acceptance-"));
  const runNonce = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({ release: proxy.releaseId, run: runNonce });
  const acceptanceUrl = `${proxyOrigin}/proofs/browser-acceptance/harness.html?${query}`;
  let browser = null;
  let browserRoot = null;
  let page = null;
  let snapshot = null;
  let screenshot = null;
  let screenshotInspection = null;
  let browserVersion = null;
  let requestSummary = null;
  const exceptions = [];
  const consoleMessages = [];
  let failure = null;

  try {
    browser = await launchBrowser(browserExecutable, profile);
    browserRoot = new CdpConnection(browser.webSocketUrl);
    browserVersion = await browserRoot.send("Browser.getVersion");
    const target = await createPageConnection(browser.webSocketUrl);
    page = target.connection;
    page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      exceptions.push(exceptionDetails);
    });
    page.on("Runtime.consoleAPICalled", ({ type, args }) => {
      consoleMessages.push({ type, values: args?.map(({ value, description }) => value ?? description) ?? [] });
    });
    await Promise.all([
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Log.enable"),
    ]);
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1600,
      screenHeight: 900,
      positionX: 0,
      positionY: 0,
    });
    await page.send("Page.navigate", { url: acceptanceUrl });
    snapshot = await waitForAcceptance(page, options.timeoutMs);
    if (exceptions.length > 0) throw new Error("Browser raised an uncaught page exception during an otherwise passing run.");
    screenshot = await captureScreenshot(page, true);
    screenshotInspection = inspectScreenshotPng(screenshot);
    await waitForRequestIdle(proxy);
    requestSummary = proxy.summarizeRequests();
    if (requestSummary.violations.length > 0) {
      throw new Error(`Artifact request gate failed: ${requestSummary.violations.join(" ")}`);
    }
  } catch (error) {
    failure = error;
    snapshot = error.acceptanceSnapshot ?? snapshot;
    if (!snapshot && page) {
      try {
        snapshot = await evaluate(page, "globalThis.__omarchyBrowserAcceptance?.snapshot?.() ?? null");
      } catch {
        // The page may have crashed; the outer error is the primary evidence.
      }
    }
    if (!screenshot && page) {
      try {
        screenshot = await captureScreenshot(page, false);
        try {
          screenshotInspection = inspectScreenshotPng(screenshot);
        } catch (inspectionError) {
          screenshotInspection = {
            valid: false,
            error: inspectionError.message,
          };
        }
      } catch {
        // A crashed target cannot provide a diagnostic screenshot.
      }
    }
    requestSummary ??= proxy.summarizeRequests();
  } finally {
    page?.close();
    browserRoot?.close();
    if (browser?.child) await waitForExit(browser.child);
    await close(proxy.server).catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }

  const verdict = failure ? "failed" : "passed";
  const evidence = {
    schemaVersion: 1,
    verdict,
    completedAt: new Date().toISOString(),
    releaseBaseUrl: proxy.releaseBaseUrl,
    acceptanceUrl,
    browserExecutable,
    browser: browserVersion,
    contract: snapshot,
    browserExceptions: exceptions,
    browserConsole: consoleMessages,
    failure: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null,
  };
  const persisted = await persistEvidence(output, {
    evidence,
    screenshot,
    screenshotInspection,
    requests: requestSummary,
    manifestBody: proxy.manifestBody,
    releaseId: proxy.releaseId,
    worker: proxy.worker,
    rootfs: proxy.rootfs,
    acceptanceSourceHashes: proxy.acceptanceSourceHashes,
  });
  if (failure) {
    throw Object.assign(new Error(`Browser acceptance failed; evidence: ${output}\n${failure.message}`), {
      cause: failure,
      output,
    });
  }
  return persisted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(usage());
    else {
      const result = await runAcceptance(options);
      process.stdout.write(`PASS ${result.output}\n${result.files.map((file) => `  ${basename(file)}`).join("\n")}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

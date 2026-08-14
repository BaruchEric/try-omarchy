#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  VerificationResult,
  finishCli,
  parseArguments,
} from "./lib.mjs";

function header(response, name) {
  return response.headers.get(name)?.trim() ?? "";
}

function isLocalHttp(url) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

export async function checkDeployment(
  pageUrl,
  { manifestUrl, allowLocalHttp = false, fetchImpl = fetch } = {},
) {
  const result = new VerificationResult("deployed web runtime");
  const parsedPageUrl = new URL(pageUrl);
  result.check(
    "DEPLOY-001",
    parsedPageUrl.protocol === "https:" ||
      (allowLocalHttp && isLocalHttp(parsedPageUrl)),
    "page uses HTTPS (or explicitly allowed localhost HTTP)",
    parsedPageUrl.href,
  );

  let pageResponse;
  try {
    pageResponse = await fetchImpl(parsedPageUrl, {
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    result.check(
      "DEPLOY-002",
      pageResponse.ok,
      "page returns a successful response",
      pageResponse.status,
    );
  } catch (error) {
    result.check("DEPLOY-002", false, "page can be fetched", error.message);
    return result;
  }

  const coop = header(pageResponse, "cross-origin-opener-policy").toLowerCase();
  const coep = header(pageResponse, "cross-origin-embedder-policy").toLowerCase();
  result.check(
    "WEB-001",
    coop === "same-origin" && ["require-corp", "credentialless"].includes(coep),
    "page sends COOP same-origin and a compatible COEP policy",
    { coop, coep },
  );
  result.check(
    "DEPLOY-003",
    /^text\/html\b/i.test(header(pageResponse, "content-type")),
    "page is served as HTML",
    header(pageResponse, "content-type"),
  );

  if (!manifestUrl) return result;

  let manifest;
  let resolvedManifestUrl;
  try {
    resolvedManifestUrl = new URL(manifestUrl, parsedPageUrl);
    const response = await fetchImpl(resolvedManifestUrl, {
      headers: { accept: "application/json" },
    });
    result.check(
      "DEPLOY-004",
      response.ok,
      "artifact manifest is reachable",
      response.status,
    );
    manifest = await response.json();
  } catch (error) {
    result.check(
      "DEPLOY-004",
      false,
      "artifact manifest is reachable and valid JSON",
      error.message,
    );
    return result;
  }

  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact?.path) continue;
    const artifactUrl = new URL(artifact.path, resolvedManifestUrl);
    try {
      const response = await fetchImpl(artifactUrl, {
        headers: { range: "bytes=0-0" },
      });
      const contentRange = header(response, "content-range");
      const cacheControl = header(response, "cache-control").toLowerCase();
      result.check(
        `WEB-002-${artifact.role}-RANGE`,
        response.status === 206 && /^bytes 0-0\/\d+$/i.test(contentRange),
        `${artifact.role} supports a one-byte HTTP range request`,
        { status: response.status, contentRange },
      );
      result.check(
        `WEB-002-${artifact.role}-CACHE`,
        cacheControl.includes("immutable") &&
          /(?:^|,)\s*(?:s-maxage|max-age)=\d+/.test(cacheControl),
        `${artifact.role} is versioned with immutable caching`,
        cacheControl,
      );
      if (artifact.role === "emulator-wasm") {
        result.check(
          "WEB-002-WASM-MIME",
          /^application\/wasm\b/i.test(header(response, "content-type")),
          "WebAssembly is served as application/wasm",
          header(response, "content-type"),
        );
      }
    } catch (error) {
      result.check(
        `WEB-002-${artifact.role}-FETCH`,
        false,
        `${artifact.role} can be range-fetched`,
        error.message,
      );
    }
  }

  return result;
}

async function main() {
  const { values, positional } = parseArguments(process.argv.slice(2), {
    manifest: "string",
    "allow-local-http": "boolean",
    json: "boolean",
  });
  if (!positional[0]) {
    throw new Error(
      "Usage: check-deployment.mjs <page-url> [--manifest URL] [--allow-local-http] [--json]",
    );
  }
  const result = await checkDeployment(positional[0], {
    manifestUrl: values.manifest,
    allowLocalHttp: values["allow-local-http"],
  });
  finishCli(result, { json: values.json });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

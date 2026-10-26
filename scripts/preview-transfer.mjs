#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname, basename } from "node:path";
import { unzipSync } from "fflate";

const MEDIA_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function safePath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return path.normalize("NFC");
}

function mediaType(path) {
  const value = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!value) throw new Error(`Unsupported file type: ${path}`);
  return value;
}

async function loadPackage(path) {
  const bytes = new Uint8Array(await readFile(path));
  if (extname(path).toLowerCase() === ".html") return new Map([["index.html", bytes]]);
  if (extname(path).toLowerCase() !== ".zip") throw new Error("Source must be .html or .zip");

  const extracted = unzipSync(bytes);
  const files = new Map();
  for (const [rawPath, content] of Object.entries(extracted)) {
    if (rawPath.endsWith("/")) continue;
    const path = safePath(rawPath);
    const key = path.toLowerCase();
    if ([...files.keys()].some((existing) => existing.toLowerCase() === key)) throw new Error(`Duplicate archive path: ${path}`);
    files.set(path, content);
  }
  return files;
}

function describe(files, sourcePath) {
  return {
    sourceFormat: extname(sourcePath).toLowerCase() === ".zip" ? "zip" : "html",
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, mediaType: mediaType(path) })),
  };
}

async function upload(sourcePath, planPath) {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required");

  const files = await loadPackage(sourcePath);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const planned = new Map(plan.files.map((file) => [file.path, file]));
  if (planned.size !== files.size) throw new Error("Local package does not match the transfer plan");

  const authHeaders = {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
  for (const [path, bytes] of files) {
    const target = planned.get(path);
    if (!target || target.size !== bytes.byteLength || target.mediaType !== mediaType(path)) {
      throw new Error(`Local asset does not match the transfer plan: ${path}`);
    }
    const response = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": target.mediaType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Upload failed for ${path}: ${response.status} ${await response.text()}`);
  }

  const committed = await fetch(plan.commitUrl, { method: "POST", headers: authHeaders });
  if (!committed.ok) throw new Error(`Commit failed: ${committed.status} ${await committed.text()}`);
  process.stdout.write(`${JSON.stringify(await committed.json())}\n`);
}

const [, , command, sourcePath, planPath] = process.argv;
try {
  if (command === "manifest" && sourcePath) {
    const files = await loadPackage(sourcePath);
    process.stdout.write(`${JSON.stringify({ title: basename(sourcePath, extname(sourcePath)), ...describe(files, sourcePath) }, null, 2)}\n`);
  } else if (command === "upload" && sourcePath && planPath) {
    await upload(sourcePath, planPath);
  } else {
    fail("Usage: preview-transfer manifest <file.html|bundle.zip> | upload <source> <transfer-plan.json>");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "Transfer failed");
}

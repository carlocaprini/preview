#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export function trustedOrigin() {
  const url = new URL(process.env.PREVIEW_MCP_ORIGIN ?? "https://preview.carlocaprini.com");
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PREVIEW_MCP_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

function exactTransferUrl(value, expected) {
  const actual = new URL(value);
  if (actual.href !== expected) throw new Error("Transfer plan contains an unexpected destination");
  return actual;
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
  const token = process.env.PREVIEW_MCP_TOKEN;
  if (!token) throw new Error("PREVIEW_MCP_TOKEN is required");

  const files = await loadPackage(sourcePath);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const origin = trustedOrigin();
  if (typeof plan.uploadId !== "string") throw new Error("Invalid transfer plan");
  const transferBase = `${origin}/api/admin/uploads/${encodeURIComponent(plan.uploadId)}`;
  const planned = new Map(plan.files.map((file) => [file.path, file]));
  if (planned.size !== files.size) throw new Error("Local package does not match the transfer plan");

  const authHeaders = { Authorization: `Bearer ${token}` };
  for (const [path, bytes] of files) {
    const target = planned.get(path);
    if (!target || target.size !== bytes.byteLength || target.mediaType !== mediaType(path)) {
      throw new Error(`Local asset does not match the transfer plan: ${path}`);
    }
    const expectedUploadUrl = `${transferBase}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(exactTransferUrl(target.uploadUrl, expectedUploadUrl), {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": target.mediaType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Upload failed for ${path}: ${response.status} ${await response.text()}`);
  }

  const committed = await fetch(exactTransferUrl(plan.commitUrl, `${transferBase}/commit`), { method: "POST", headers: authHeaders });
  if (!committed.ok) throw new Error(`Commit failed: ${committed.status} ${await committed.text()}`);
  process.stdout.write(`${JSON.stringify(await committed.json())}\n`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function responseBytes(response, expectedBytes) {
  if (!response.body) throw new Error("Download response has no body");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== expectedBytes) throw new Error("Download size does not match the transfer plan");
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) throw new Error("Download exceeds its declared size");
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error("Download is truncated");
  return output;
}

export async function download(planPath, destinationPath) {
  const token = process.env.PREVIEW_MCP_TOKEN;
  if (!token) throw new Error("PREVIEW_MCP_TOKEN is required");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (!plan || typeof plan.contentId !== "string" || typeof plan.activeVersionId !== "string" || !Array.isArray(plan.files)) {
    throw new Error("Invalid content transfer plan");
  }
  if (plan.files.length < 1 || plan.files.length > 50) throw new Error("Invalid content transfer plan file count");
  const baseOrigin = new URL(trustedOrigin());
  if (plan.transfer?.baseOrigin !== baseOrigin.origin) throw new Error("Transfer plan contains an unexpected origin");
  const files = [];
  const collisionKeys = new Set();
  let totalBytes = 0;
  for (const candidate of plan.files) {
    const path = safePath(candidate.path);
    const collisionKey = path.toLowerCase();
    if (collisionKeys.has(collisionKey)) throw new Error(`Duplicate transfer path: ${path}`);
    collisionKeys.add(collisionKey);
    if (!Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > 10 * 1024 * 1024) {
      throw new Error(`Invalid transfer size: ${path}`);
    }
    if (typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) {
      throw new Error(`Invalid transfer digest: ${path}`);
    }
    totalBytes += candidate.size;
    if (totalBytes > 20 * 1024 * 1024) throw new Error("Transfer exceeds the 20 MiB expanded limit");
    files.push({ path, size: candidate.size, sha256: candidate.sha256 });
  }

  const destination = resolve(destinationPath);
  if (await pathExists(destination)) throw new Error(`Destination already exists: ${destination}`);
  const parent = dirname(destination);
  const realParent = await realpath(parent);
  const staging = await mkdtemp(join(realParent, ".preview-download-"));
  try {
    for (const file of files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      const url = new URL(
        `/api/mcp/contents/${encodeURIComponent(plan.contentId)}/versions/${encodeURIComponent(plan.activeVersionId)}/files/${encodeURIComponent(file.path)}`,
        baseOrigin,
      );
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Download failed for ${file.path}: ${response.status}`);
      const bytes = await responseBytes(response, file.size);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== file.sha256) throw new Error(`Download digest mismatch: ${file.path}`);
      await writeFile(target, bytes, { flag: "wx" });
    }

    await mkdir(destination);
    try {
      for (const file of files) {
        const target = join(destination, file.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(staging, file.path), target, fsConstants.COPYFILE_EXCL);
      }
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ contentId: plan.contentId, activeVersionId: plan.activeVersionId, destination, files: files.length })}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv) {
  const [, , command, sourcePath, planPath] = argv;
  try {
  if (command === "manifest" && sourcePath) {
    const files = await loadPackage(sourcePath);
    process.stdout.write(`${JSON.stringify({ title: basename(sourcePath, extname(sourcePath)), ...describe(files, sourcePath) }, null, 2)}\n`);
  } else if (command === "upload" && sourcePath && planPath) {
    await upload(sourcePath, planPath);
  } else if (command === "download" && sourcePath && planPath) {
    await download(sourcePath, planPath);
  } else {
    fail("Usage: preview-transfer manifest <file.html|bundle.zip> | upload <source> <transfer-plan.json> | download <transfer-plan.json> <destination>");
  }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Transfer failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

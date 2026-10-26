const script = document.currentScript;
const token = script?.dataset.token;
const snapshotId = script?.dataset.snapshot;
const frame = document.querySelector(".viewer-frame");
const session = crypto.randomUUID();
let loaded = false;
let meaningful = false;
let visibleSince = 0;
let visibleAccumulated = 0;
let sequence = 0;

function post(kind, visibleMs = 0) {
  const receiptId = kind === "view" ? `${session}-view` : `${session}-${sequence++}`;
  fetch("/api/public/measure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, snapshotId, receiptId, kind, visibleMs }),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}

function isVisible() {
  return loaded && document.visibilityState === "visible";
}

function pauseClock() {
  if (!visibleSince) return;
  visibleAccumulated += performance.now() - visibleSince;
  visibleSince = 0;
}

function resumeClock() {
  if (isVisible() && !visibleSince) visibleSince = performance.now();
}

function flushVisible() {
  pauseClock();
  const wholeMilliseconds = Math.min(30_000, Math.floor(visibleAccumulated));
  if (meaningful && wholeMilliseconds >= 1_000) post("visible", wholeMilliseconds);
  visibleAccumulated = 0;
  resumeClock();
}

function qualifyView() {
  if (!meaningful && isVisible()) {
    meaningful = true;
    post("view");
  }
}

frame?.addEventListener("load", () => {
  loaded = true;
  resumeClock();
  setTimeout(qualifyView, 2_000);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeClock();
  else flushVisible();
});
window.addEventListener("pagehide", flushVisible);
setInterval(flushVisible, 15_000);

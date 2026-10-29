const root = document.querySelector("#admin-app");
const dialog = document.querySelector("#admin-dialog");
const notice = document.querySelector("#notice");
const contentId = location.pathname.match(/^\/admin\/contents\/([^/]+)$/)?.[1];
const LIMIT_BYTES = 20 * 1024 * 1024;
const LIMIT_FILES = 50;
const PDF_LIMIT_BYTES = 10 * 1024 * 1024;

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatDuration(milliseconds) {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function viewsHistory(aggregates) {
  const points = (Array.isArray(aggregates) ? aggregates : []).slice(-30).flatMap((entry) => {
    const day = typeof entry?.day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(entry.day) ? entry.day : null;
    const value = Number(entry?.meaningfulViews);
    return day ? [{ day, views: Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0 }] : [];
  });
  const total = points.reduce((sum, point) => sum + point.views, 0);
  const peak = Math.max(0, ...points.map((point) => point.views));
  const summary = `<p class="sr-only">30-day total: ${total} meaningful view${total === 1 ? "" : "s"}. Daily UTC values: ${points.map((point) => `${escapeHtml(point.day)}, ${point.views}`).join("; ")}.</p>`;
  const heading = '<header class="history-head"><div><h2 id="views-history-title">Views over time</h2><span>Last 30 days · UTC</span></div></header>';

  if (!points.length || peak === 0) {
    return `<section class="history-panel" aria-labelledby="views-history-title">${heading}<p class="history-empty">No views in the last 30 days</p>${summary}</section>`;
  }

  const bars = points.map((point, index) => {
    const height = (point.views / peak) * 76;
    return `<rect class="history-bar" data-day="${escapeHtml(point.day)}" data-views="${point.views}" x="${index * 10 + 2}" y="${86 - height}" width="6" height="${height}"><title>${escapeHtml(point.day)}: ${point.views} meaningful view${point.views === 1 ? "" : "s"}</title></rect>`;
  }).join("");
  const labels = [0, Math.floor((points.length - 1) / 2), points.length - 1].map((index, labelIndex) => {
    const anchor = labelIndex === 0 ? "start" : labelIndex === 2 ? "end" : "middle";
    const x = labelIndex === 0 ? 2 : labelIndex === 2 ? 298 : 150;
    return `<text x="${x}" y="106" text-anchor="${anchor}">${escapeHtml(points[index].day.slice(5))}</text>`;
  }).join("");
  return `<section class="history-panel" aria-labelledby="views-history-title">${heading}<svg class="history-chart" viewBox="0 0 300 112" role="img" aria-label="Meaningful views by UTC day. 30-day total ${total}; peak ${peak}."><line x1="2" x2="298" y1="10" y2="10"></line><line x1="2" x2="298" y1="48" y2="48"></line><line x1="2" x2="298" y1="86" y2="86"></line>${bars}${labels}</svg>${summary}</section>`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    location.replace(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
    throw new Error("Session expired");
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

document.querySelector("[data-action=logout]")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.replace("/login");
});

function flash(message, type = "success") {
  notice.textContent = message;
  notice.dataset.type = type;
  notice.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { notice.hidden = true; }, 5_000);
}

function openDialog(title, body, submitLabel, handler) {
  dialog.innerHTML = `<form method="dialog" class="dialog-card"><header><h2>${escapeHtml(title)}</h2><button class="icon-button" value="cancel" aria-label="Close">×</button></header>${body}<footer><button class="button secondary" value="cancel">Cancel</button><button class="button" value="submit">${escapeHtml(submitLabel)}</button></footer></form>`;
  const form = dialog.querySelector("form");
  form.addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (submitter?.value !== "submit") return;
    event.preventDefault();
    submitter.disabled = true;
    submitter.textContent = "Working…";
    try {
      await handler(new FormData(form));
      dialog.close();
    } catch (error) {
      flash(error instanceof Error ? error.message : "Something went wrong", "error");
      submitter.disabled = false;
      submitter.textContent = submitLabel;
    }
  });
  dialog.showModal();
}

function normalizeZip(entries) {
  const names = Object.keys(entries).filter((name) => !name.endsWith("/") && !name.startsWith("__MACOSX/"));
  if (!names.includes("index.html")) {
    const roots = new Set(names.map((name) => name.split("/")[0]));
    if (roots.size === 1 && names.every((name) => name.includes("/"))) {
      const prefix = `${[...roots][0]}/`;
      return Object.fromEntries(names.map((name) => [name.slice(prefix.length), entries[name]]));
    }
  }
  return Object.fromEntries(names.map((name) => [name, entries[name]]));
}

async function packageFile(file) {
  if (!file) throw new Error("Choose an HTML or ZIP file.");
  if (file.size > LIMIT_BYTES) throw new Error("The selected file exceeds 20 MiB.");
  if (file.name.toLowerCase().endsWith(".html")) {
    return { sourceFormat: "html", files: [{ path: "index.html", data: new Uint8Array(await file.arrayBuffer()) }] };
  }
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Only .html and .zip files are supported.");
  let count = 0;
  let total = 0;
  const archive = window.fflate.unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter(entry) {
      if (entry.name.endsWith("/") || entry.name.startsWith("__MACOSX/")) return false;
      count += 1;
      total += entry.originalSize;
      if (count > LIMIT_FILES || total > LIMIT_BYTES) throw new Error("ZIP exceeds the 50-file or 20 MiB limit.");
      return true;
    },
  });
  const normalized = normalizeZip(archive);
  if (!normalized["index.html"]) throw new Error("ZIP must contain index.html at its root.");
  return { sourceFormat: "zip", files: Object.entries(normalized).map(([path, data]) => ({ path, data })) };
}

async function transfer(title, file, existingContentId) {
  const bundle = await packageFile(file);
  const manifest = bundle.files.map(({ path, data }) => ({ path, size: data.byteLength }));
  const endpoint = existingContentId ? `/api/admin/contents/${existingContentId}/versions` : "/api/admin/contents";
  const payload = existingContentId
    ? { sourceFormat: bundle.sourceFormat, files: manifest }
    : { title, sourceFormat: bundle.sourceFormat, files: manifest };
  const plan = await api(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  for (const item of plan.files) {
    const fileData = bundle.files.find((candidate) => candidate.path === item.path)?.data;
    await api(item.uploadUrl, { method: "PUT", headers: { "content-type": item.mediaType }, body: fileData });
  }
  await api(plan.commitUrl, { method: "POST" });
  return plan.contentId;
}

function uploadDialog(existingContentId) {
  openDialog(
    existingContentId ? "Update HTML" : "Add interactive content",
    `${existingContentId ? "" : '<label>Title<input name="title" required maxlength="160" placeholder="A clear internal title"></label>'}<label>HTML or ZIP package<input name="file" type="file" accept=".html,.zip,text/html,application/zip" required><small>Root index.html · up to 50 files · 20 MiB total</small></label><div class="progress-note">The new version becomes active only after every asset is verified.</div>`,
    "Upload and activate",
    async (data) => {
      const id = await transfer(String(data.get("title") || ""), data.get("file"), existingContentId);
      location.assign(`/admin/contents/${id}`);
    },
  );
}

function linkDialog() {
  openDialog(
    "Create a share link",
    '<label>Internal label<input name="label" required maxlength="120" placeholder="Client review"></label><label>Expiry<select name="expiry"><option value="604800">7 days</option><option value="2592000">30 days</option><option value="">No expiry</option></select></label>',
    "Create link",
    async (data) => {
      const raw = String(data.get("expiry"));
      const result = await api(`/api/admin/contents/${contentId}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: data.get("label"), validForSeconds: raw ? Number(raw) : null }) });
      await navigator.clipboard.writeText(result.url).catch(() => {});
      flash("Share link created and copied.");
      await renderDetail();
    },
  );
}

function pdfUploadDialog(item) {
  const replacing = (item.pdfCompanion?.state || "none") !== "none";
  openDialog(
    replacing ? "Replace PDF companion" : "Upload PDF companion",
    '<label>PDF file<input name="file" type="file" accept=".pdf,application/pdf" required><small>PDF only · up to 10 MiB. The existing approved PDF remains available until replacement succeeds.</small></label>',
    replacing ? "Upload replacement" : "Upload PDF",
    async (data) => {
      const file = data.get("file");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF file.");
      if (file.size <= 0 || file.size > PDF_LIMIT_BYTES) throw new Error("PDF must be between 1 byte and 10 MiB.");
      const plan = await api(`/api/admin/contents/${contentId}/pdf/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, size: file.size, expectedActiveVersionId: item.activeVersionId }),
      });
      await api(plan.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: file });
      await api(plan.commitUrl, { method: "POST" });
      flash(replacing ? "PDF companion replaced." : "PDF companion uploaded.");
      await renderDetail();
    },
  );
}

function pdfPanel(item) {
  const pdf = item.pdfCompanion || { state: "none" };
  if (pdf.state === "none") {
    return '<section class="panel"><header><div><span class="eyebrow">Companion</span><h2>PDF</h2></div></header><div class="panel-empty"><p>No PDF companion</p><button class="button secondary" data-action="pdf-upload">Upload PDF</button></div></section>';
  }
  const outdated = pdf.state === "outdated";
  return `<section class="panel"><header><div><span class="eyebrow">Companion</span><h2>PDF</h2></div></header><div class="panel-empty"><strong>${escapeHtml(pdf.fileName)}</strong><p>${formatBytes(pdf.size)} · Uploaded ${formatDate(pdf.uploadedAt)}</p>${outdated ? '<p class="progress-note">PDF needs confirmation for this HTML version. It is hidden from shared links until confirmed or replaced.</p>' : '<p>Available from every active share link.</p>'}<div class="actions">${outdated ? `<button class="button" data-action="pdf-confirm" data-pdf-id="${escapeHtml(pdf.id)}" data-version-id="${escapeHtml(item.activeVersionId)}">Confirm reuse</button>` : ""}<button class="button secondary" data-action="pdf-upload">${outdated ? "Upload replacement" : "Replace PDF"}</button><button class="text-button danger" data-action="pdf-remove">Remove PDF</button></div></div></section>`;
}

async function renderLibrary() {
  const { contents } = await api("/api/admin/contents");
  root.innerHTML = `<section class="admin-head"><h1>Library</h1><button class="button" data-action="upload">Add content</button></section>${contents.length ? `<div class="library-list">${contents.map((item) => `<a class="content-row" href="/admin/contents/${encodeURIComponent(item.id)}"><div class="content-row-main"><h2>${escapeHtml(item.title)}</h2><span class="row-meta">Updated ${formatDate(item.updatedAt)}</span></div><div class="content-row-stats"><span class="status">${item.activeLinkCount} active link${item.activeLinkCount === 1 ? "" : "s"}</span><span>${item.meaningfulViews} view${item.meaningfulViews === 1 ? "" : "s"}</span><span>${formatDuration(item.activeVisibleMs)} visible</span></div></a>`).join("")}</div>` : '<section class="empty"><span class="empty-mark">◇</span><h2>Your private library is empty</h2><p>Upload one HTML file or a ZIP package. Nothing becomes public until you create a share link.</p><button class="button" data-action="upload">Add your first item</button></section>'}`;
}

async function renderDetail() {
  const item = await api(`/api/admin/contents/${contentId}`);
  const active = (item.versions || []).find((version) => version.id === item.activeVersionId);
  const views = item.links.reduce((sum, link) => sum + link.meaningfulViews, 0);
  const visibleTime = item.links.reduce((sum, link) => sum + link.activeVisibleMs, 0);
  const pdfDownloads = item.links.reduce((sum, link) => sum + link.pdfDownloadsServed, 0);
  const activeLinks = item.links.filter((link) => link.state === "active").length;
  const contentMeta = active
    ? `${escapeHtml(active.sourceFormat.toUpperCase())} · Updated ${formatDate(item.updatedAt)}`
    : `Updated ${formatDate(item.updatedAt)}`;
  root.innerHTML = `<a class="back" href="/admin">← Library</a><section class="detail-head"><div><h1>${escapeHtml(item.title)}</h1><p class="detail-meta">${contentMeta}</p></div><div class="actions"><a class="button secondary" href="/api/admin/contents/${item.id}/preview" target="_blank" rel="noopener">Open preview</a><button class="button secondary" data-action="version">Update HTML</button><button class="button" data-action="link">Create link</button></div></section><section class="metric-row" aria-label="Content engagement"><div><span>Meaningful views</span><strong>${views}</strong></div><div><span>Visible time</span><strong>${formatDuration(visibleTime)}</strong></div><div><span>PDF downloads</span><strong>${pdfDownloads}</strong></div><div><span>Active links</span><strong>${activeLinks}</strong></div></section>${viewsHistory(item.aggregates)}<div class="detail-grid"><section class="panel"><header><h2>Share links</h2></header>${item.links.length ? `<div class="link-list">${item.links.map((link) => `<article class="link-row"><div><div class="link-title"><strong>${escapeHtml(link.label)}</strong><span class="status ${link.state}">${link.state}</span></div><small>${link.meaningfulViews} views · ${formatDuration(link.activeVisibleMs)} visible · ${link.pdfDownloadsServed} PDF downloads · ${link.expiresAt ? `Expires ${formatDate(link.expiresAt)}` : "No expiry"}</small></div><div class="row-actions"><button class="text-button" data-action="copy" data-url="${escapeHtml(link.url)}">Copy</button>${link.state !== "revoked" ? `<button class="text-button" data-action="expiry" data-id="${link.id}" data-expiry="${escapeHtml(link.expiresAt || "")}">Edit expiry</button><button class="text-button danger" data-action="revoke" data-id="${link.id}">Revoke</button>` : ""}</div></article>`).join("")}</div>` : '<div class="panel-empty">No links yet. This content is private.</div>'}</section>${pdfPanel(item)}</div>`;
}

root.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "upload") uploadDialog();
  if (action === "version") uploadDialog(contentId);
  if (action === "link") linkDialog();
  if (action === "pdf-upload") {
    const item = await api(`/api/admin/contents/${contentId}`);
    pdfUploadDialog(item);
  }
  if (action === "pdf-confirm") {
    await api(`/api/admin/contents/${contentId}/pdf/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pdfId: button.dataset.pdfId, expectedActiveVersionId: button.dataset.versionId }) });
    flash("PDF companion confirmed for this HTML version.");
    await renderDetail();
  }
  if (action === "pdf-remove" && confirm("Remove this PDF companion from every share link?")) {
    await api(`/api/admin/contents/${contentId}/pdf`, { method: "DELETE" });
    flash("PDF companion removed.");
    await renderDetail();
  }
  if (action === "copy") {
    await navigator.clipboard.writeText(button.dataset.url);
    flash("Link copied.");
  }
  if (action === "expiry") {
    openDialog("Edit link expiry", `<label>Expiry date and time<input name="expiry" type="datetime-local" value="${button.dataset.expiry ? new Date(button.dataset.expiry).toISOString().slice(0, 16) : ""}"><small>Leave empty for no expiry.</small></label>`, "Save expiry", async (data) => {
      const value = String(data.get("expiry"));
      await api(`/api/admin/links/${button.dataset.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresAt: value ? new Date(value).toISOString() : null }) });
      flash("Expiry updated.");
      await renderDetail();
    });
  }
  if (action === "revoke" && confirm("Revoke this link now? Anyone using it will immediately lose access.")) {
    await api(`/api/admin/links/${button.dataset.id}/revoke`, { method: "POST" });
    flash("Link revoked.");
    await renderDetail();
  }
});

(contentId ? renderDetail() : renderLibrary()).catch((error) => {
  root.innerHTML = `<section class="empty"><h2>Could not load the workspace</h2><p>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p></section>`;
});

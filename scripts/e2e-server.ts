import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adminPage, homePage, loginPage, unavailablePage, viewerPage } from "../src/ui/pages.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const adminScript = readFileSync(`${root}/src/client/admin.js`, "utf8");
const loginScript = readFileSync(`${root}/src/client/login.js`, "utf8");
const viewerScript = readFileSync(`${root}/src/client/viewer.js`, "utf8");
const fflateScript = readFileSync(`${root}/node_modules/fflate/umd/index.js`, "utf8");
const port = Number(process.env.E2E_PORT ?? 43917);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/assets/admin.js") return send(response, adminScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/login.js") return send(response, loginScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/viewer.js") return send(response, viewerScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/fflate.js") return send(response, fflateScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/content") return send(response, "<!doctype html><h1>Shared prototype</h1>", "text/html; charset=utf-8");
  if (url.pathname === "/viewer") {
    return send(
      response,
      viewerPage(`http://127.0.0.1:${port}/content`, { token: "test-token", snapshotId: "snapshot" }),
      "text/html; charset=utf-8",
    );
  }
  if (url.pathname === "/unavailable") return send(response, unavailablePage(), "text/html; charset=utf-8", 410);
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    response.setHeader("set-cookie", "__Host-preview_owner=test; Path=/; HttpOnly; Secure; SameSite=Strict");
    return send(response, JSON.stringify({ authenticated: true }), "application/json; charset=utf-8");
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return send(response, JSON.stringify({ authenticated: false }), "application/json; charset=utf-8");
  }
  if (url.pathname === "/login") return send(response, loginPage(), "text/html; charset=utf-8");
  if (url.pathname === "/admin" || /^\/admin\/contents\/[^/]+$/u.test(url.pathname)) {
    return send(response, adminPage(), "text/html; charset=utf-8");
  }
  if (url.pathname === "/") return send(response, homePage(), "text/html; charset=utf-8");
  return send(response, "Not found", "text/plain; charset=utf-8", 404);
}).listen(port, "127.0.0.1", () => console.log(`E2E server listening on http://127.0.0.1:${port}`));

function send(response: import("node:http").ServerResponse, body: string, mediaType: string, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", mediaType);
  response.end(body);
}

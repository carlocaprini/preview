const appOrigin = new URL(process.env.APP_ORIGIN ?? "https://preview.carlocaprini.com").origin;
const contentOrigin = new URL(process.env.CONTENT_ORIGIN ?? "https://content.preview.carlocaprini.com").origin;

const homepage = await fetch(`${appOrigin}/`, { redirect: "manual" });
assert(homepage.status === 200, `Homepage returned ${homepage.status}`);
assert((homepage.headers.get("referrer-policy") ?? "") === "no-referrer", "Homepage referrer policy is missing");
assert((homepage.headers.get("cache-control") ?? "").includes("no-store"), "Homepage cache policy is unsafe");
assert((await homepage.text()).includes("Ideas, experiments and work worth sharing."), "Homepage brand copy is missing");

const admin = await fetch(`${appOrigin}/admin`, { redirect: "manual" });
assert(admin.status === 303, `Anonymous admin access returned ${admin.status}`);
assert((admin.headers.get("location") ?? "").startsWith("/login"), "Anonymous admin was not redirected to login");

const loginPage = await fetch(`${appOrigin}/login`, { redirect: "manual" });
assert(loginPage.status === 200, `Login page returned ${loginPage.status}`);
assert((await loginPage.text()).includes('id="login-form"'), "Login form is missing");

const login = await fetch(`${appOrigin}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: appOrigin },
  body: JSON.stringify({ password: process.env.OWNER_PASSWORD }),
  redirect: "manual",
});
assert(login.status === 200, `Owner login returned ${login.status}`);
const ownerCookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
assert(ownerCookie.startsWith("__Host-preview_owner="), "Owner session cookie is missing");

const authenticatedAdmin = await fetch(`${appOrigin}/admin`, {
  headers: { cookie: ownerCookie },
  redirect: "manual",
});
assert(authenticatedAdmin.status === 200, `Authenticated admin returned ${authenticatedAdmin.status}`);
assert((await authenticatedAdmin.text()).includes('id="admin-app"'), "Authenticated admin shell is missing");

const anonymousMcp = await fetch(`${appOrigin}/mcp`, { redirect: "manual" });
assert(anonymousMcp.status === 401, `Anonymous MCP access returned ${anonymousMcp.status}`);

const authenticatedMcp = await fetch(`${appOrigin}/mcp`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  redirect: "manual",
});
assert(![401, 403].includes(authenticatedMcp.status), `Authenticated MCP was rejected with ${authenticatedMcp.status}`);

const contentRoot = await fetch(`${contentOrigin}/`, { redirect: "manual" });
assert(contentRoot.status === 404, `Content origin root returned ${contentRoot.status}`);
assert(!(await contentRoot.text()).includes('id="admin-app"'), "Content origin exposed the owner workspace");

console.log("Production origin, authentication, cache, and isolation boundaries verified.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

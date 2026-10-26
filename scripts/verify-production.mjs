const appOrigin = new URL(process.env.APP_ORIGIN ?? "https://preview.carlocaprini.com").origin;
const contentOrigin = new URL(process.env.CONTENT_ORIGIN ?? "https://content.preview.carlocaprini.com").origin;

const homepage = await fetch(`${appOrigin}/`, { redirect: "manual" });
assert(homepage.status === 200, `Homepage returned ${homepage.status}`);
assert((homepage.headers.get("referrer-policy") ?? "") === "no-referrer", "Homepage referrer policy is missing");
assert((homepage.headers.get("cache-control") ?? "").includes("no-store"), "Homepage cache policy is unsafe");
assert((await homepage.text()).includes("Ideas, experiments and work worth sharing."), "Homepage brand copy is missing");

const admin = await fetch(`${appOrigin}/admin`, { redirect: "manual" });
assert(admin.status !== 200, "Anonymous admin access unexpectedly succeeded");

const contentRoot = await fetch(`${contentOrigin}/`, { redirect: "manual" });
assert(contentRoot.status === 404, `Content origin root returned ${contentRoot.status}`);
assert(!(await contentRoot.text()).includes('id="admin-app"'), "Content origin exposed the owner workspace");

console.log("Production origin, access, cache, and isolation boundaries verified.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

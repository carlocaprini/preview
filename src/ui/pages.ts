function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const styles = `
:root{color-scheme:light;--paper:#f7f7f2;--ink:#101828;--muted:#667085;--line:#d9dedc;--cyan:#087c91;--night:#07111d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);min-height:100vh}.page{width:min(72rem,calc(100% - 2rem));margin:auto}.mark{display:inline-flex;gap:.6rem;align-items:center;color:inherit;text-decoration:none;font-weight:750;letter-spacing:-.02em}.mark::before{content:"";width:.7rem;height:.7rem;border-radius:2px;background:var(--night);box-shadow:.28rem .28rem 0 #22d3ee}.top{display:flex;justify-content:space-between;align-items:center;padding:1.1rem 0;border-bottom:1px solid var(--line)}main{display:grid;align-content:center;min-height:calc(100vh - 5rem);padding:4rem 0}.eyebrow{color:var(--cyan);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(2.8rem,8vw,6.5rem);line-height:.95;letter-spacing:-.055em;max-width:12ch;margin:.55rem 0 1.2rem}p{max-width:42rem;color:var(--muted);font-size:clamp(1rem,2vw,1.2rem);line-height:1.65}.cta{display:inline-flex;margin-top:1.2rem;padding:.85rem 1.1rem;border-radius:999px;background:var(--night);color:white;text-decoration:none;font-weight:750}.cta:focus-visible,.mark:focus-visible,a:focus-visible{outline:3px solid #12a5bd;outline-offset:4px}.lost{margin-top:4rem;padding-top:1.25rem;border-top:1px solid var(--line);font-size:.95rem}.lost a{color:var(--ink);font-weight:700}.admin-card{background:white;border:1px solid var(--line);border-radius:1rem;padding:1.5rem;box-shadow:0 18px 60px rgb(16 24 40/.08)}@media(max-width:40rem){.page{width:min(100% - 1.25rem,72rem)}main{padding:2rem 0}.top{padding:.9rem 0}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${body}</body></html>`;
}

export function homePage(): string {
  return document("Preview — Carlo Caprini", `<div class="page"><header class="top"><a class="mark" href="https://carlocaprini.com">Carlo Caprini</a><span class="eyebrow">Preview</span></header><main><div><span class="eyebrow">A space for shared work</span><h1>Ideas, experiments and work worth sharing.</h1><p>Interactive experiences and supporting materials shared by Carlo Caprini.</p><a class="cta" href="https://carlocaprini.com">Explore my work</a><p class="lost">Lost the link to something I shared with you? <a href="https://carlocaprini.com/#contact">Get in touch</a> and I’ll help you find it.</p></div></main></div>`);
}

export function adminFoundationPage(): string {
  return document("Preview — Library", `<div class="page"><header class="top"><a class="mark" href="https://carlocaprini.com">Carlo Caprini</a><span class="eyebrow">Preview / Library</span></header><main><section class="admin-card"><span class="eyebrow">Owner workspace</span><h1>Library foundation ready.</h1><p>The authenticated content library will appear here. Public content remains private until an active share link exists.</p></section></main></div>`);
}

export function unavailablePage(): string {
  return document("Preview unavailable — Carlo Caprini", `<div class="page"><header class="top"><a class="mark" href="https://carlocaprini.com">Carlo Caprini</a><span class="eyebrow">Preview</span></header><main><div><span class="eyebrow">Shared work</span><h1>This preview is no longer available.</h1><p>The link may have expired or the content may no longer be shared.</p><a class="cta" href="https://carlocaprini.com">Explore Carlo’s work</a></div></main></div>`);
}

export function viewerPage(iframeSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Shared preview — Carlo Caprini</title><style>${styles}
html,body{height:100%;overflow:hidden}.viewer{height:100%;display:grid;grid-template-rows:3.4rem 1fr}.viewer .top{width:100%;padding:.7rem 1rem;background:var(--paper)}.viewer-frame{display:block;width:100%;height:100%;border:0;background:white}@media(max-width:40rem){.viewer{grid-template-rows:3rem}.viewer .top{padding:.55rem .7rem}.viewer .eyebrow{display:none}}
</style></head><body><div class="viewer"><header class="top"><a class="mark" href="https://carlocaprini.com" target="_blank" rel="noopener noreferrer">Carlo Caprini</a><span class="eyebrow">Shared preview</span></header><iframe class="viewer-frame" title="Shared interactive content" src="${escapeHtml(iframeSource)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerpolicy="no-referrer"></iframe></div></body></html>`;
}

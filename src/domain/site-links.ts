const SITE_ORIGIN = "https://carlocaprini.com";
const CONTENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PublicSitePage = "home" | "about" | "privacy" | "unavailable" | "not_found";

type SiteAttribution =
  | { page: PublicSitePage }
  | { contentId: string };

function campaign(attribution: SiteAttribution): { campaign: "public_pages" | "shared_content"; content: string } {
  if ("page" in attribution) return { campaign: "public_pages", content: attribution.page };
  if (!CONTENT_ID_PATTERN.test(attribution.contentId)) throw new Error("A canonical content UUID is required for site attribution");
  return {
    campaign: "shared_content",
    content: `doc_${attribution.contentId.replaceAll("-", "").toLowerCase()}`,
  };
}

export function siteReferralUrl(destination: string, attribution: SiteAttribution): string {
  const url = new URL(destination, SITE_ORIGIN);
  if (url.origin !== SITE_ORIGIN) throw new Error("Site referrals must use the canonical site origin");
  const values = campaign(attribution);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.set("utm_source", "preview");
  url.searchParams.set("utm_medium", "referral");
  url.searchParams.set("utm_campaign", values.campaign);
  url.searchParams.set("utm_content", values.content);
  return url.toString();
}

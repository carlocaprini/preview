const MAX_PATH_LENGTH = 512;

export function normalizeAssetPath(input: string): string {
  if (!input || input.length > MAX_PATH_LENGTH) throw new Error("Invalid asset path");
  if (input.includes("\\") || input.includes("\0")) throw new Error("Invalid asset path");

  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    throw new Error("Invalid asset path encoding");
  }

  if (decoded.startsWith("/") || decoded.endsWith("/")) throw new Error("Invalid asset path");
  const segments = decoded.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid asset path");
  }

  const normalized = segments.join("/");
  if (encodeURI(normalized).toLowerCase().includes("%2f")) throw new Error("Invalid asset path");
  return normalized.normalize("NFC");
}

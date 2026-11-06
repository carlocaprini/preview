import adminScript from "./client/admin.js?raw";
import loginScript from "./client/login.js?raw";
import viewerScript from "./client/viewer.js?raw";
import fflateScript from "../node_modules/fflate/umd/index.js?raw";
import favicon from "./assets/favicon.svg?raw";
import socialPreviewUrl from "./assets/preview-social.png?inline";

function decodeInlineAsset(dataUrl: string): ArrayBuffer {
  const separator = dataUrl.indexOf(",");
  if (separator === -1 || !dataUrl.slice(0, separator).endsWith(";base64")) {
    throw new Error("Expected an inline base64 asset");
  }
  const binary = atob(dataUrl.slice(separator + 1));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

const socialPreview = decodeInlineAsset(socialPreviewUrl);

export function clientAsset(path: string): { body: BodyInit; mediaType: string } | null {
  if (path === "/assets/admin.js") return { body: adminScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/login.js") return { body: loginScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/viewer.js") return { body: viewerScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/fflate.js") return { body: fflateScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/preview-social.png") return { body: socialPreview, mediaType: "image/png" };
  if (path === "/favicon.svg") return { body: favicon, mediaType: "image/svg+xml; charset=utf-8" };
  return null;
}

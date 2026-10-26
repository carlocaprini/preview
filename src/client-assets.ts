import adminScript from "./client/admin.js?raw";
import viewerScript from "./client/viewer.js?raw";
import fflateScript from "../node_modules/fflate/umd/index.js?raw";

export function clientAsset(path: string): { body: string; mediaType: string } | null {
  if (path === "/assets/admin.js") return { body: adminScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/viewer.js") return { body: viewerScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/fflate.js") return { body: fflateScript, mediaType: "text/javascript; charset=utf-8" };
  return null;
}

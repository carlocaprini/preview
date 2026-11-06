import adminScript from "./client/admin.js?raw";
import loginScript from "./client/login.js?raw";
import viewerScript from "./client/viewer.js?raw";
import fflateScript from "../node_modules/fflate/umd/index.js?raw";

const FFLATE_LICENSE = `/*!
 * fflate 0.8.3 — https://github.com/101arrowz/fflate
 * MIT License
 * Copyright (c) 2026 Arjun Barrett
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */`;

const licensedFflateScript = `${FFLATE_LICENSE}\n${fflateScript}`;

export function clientAsset(path: string): { body: string; mediaType: string } | null {
  if (path === "/assets/admin.js") return { body: adminScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/login.js") return { body: loginScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/viewer.js") return { body: viewerScript, mediaType: "text/javascript; charset=utf-8" };
  if (path === "/assets/fflate.js") return { body: licensedFflateScript, mediaType: "text/javascript; charset=utf-8" };
  return null;
}

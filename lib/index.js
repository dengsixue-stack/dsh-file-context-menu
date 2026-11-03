import { exec, execFile, execFileSync } from "child_process";
import crypto from "crypto";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import * as win from "./platform-win.js";

const IS_WIN = process.platform === "win32";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const BRIDGE_PREFIX = "/api/dsh-file-menu";

const ICONS_CACHE_DIR = path.join(os.tmpdir(), "dsh-fcm-icons");
try {
  fs.mkdirSync(ICONS_CACHE_DIR, { recursive: true });
} catch {}

const STATE_DIR = IS_WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "dsh-file-menu")
  : path.join(os.homedir(), "Library", "Application Support", "dsh-file-menu");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const JXA_PATH = path.join(STATE_DIR, "list-apps.js");

// macOS only: apps that sit directly in these folders are offered in the menu.
const APP_ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  path.join(os.homedir(), "Applications")
];
const MAX_APPS = 12;
const APP_CACHE_TTL_MS = 10 * 60 * 1000;
const appListCache = new Map();

// JXA asks macOS LaunchServices which apps can open a file, the same list Finder shows in "打开方式".
const JXA_SOURCE = `ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const fm = $.NSFileManager.defaultManager;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const def = ws.URLForApplicationToOpenURL(url);
  const list = ws.URLsForApplicationsToOpenURL(url);
  const apps = [];
  for (let i = 0; i < list.count; i++) {
    const p = list.objectAtIndex(i).path.js;
    apps.push({ path: p, name: fm.displayNameAtPath(p).js });
  }
  return JSON.stringify({ defaultPath: def ? def.path.js : "", apps: apps });
}
`;

let jxaWritten = false;
function ensureJxa() {
  if (jxaWritten) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(JXA_PATH, JXA_SOURCE);
  jxaWritten = true;
}

function normalizeAppPath(p) {
  // Safari is reported under the Cryptex volume; its real location is /System/Applications.
  return p.replace(/^\/System\/Volumes\/Preboot\/Cryptexes\/App(?=\/System\/)/, "");
}

function isAllowedApp(p) {
  return p.endsWith(".app") && APP_ROOTS.includes(path.dirname(p)) && fs.existsSync(p);
}

function findIcnsFile(bundlePath) {
  const resDir = path.join(bundlePath, "Contents", "Resources");
  let declared = "";
  try {
    declared = execFileSync("/usr/bin/defaults", ["read", path.join(bundlePath, "Contents", "Info.plist"), "CFBundleIconFile"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).trim();
  } catch {}
  if (declared) {
    const name = declared.endsWith(".icns") ? declared : `${declared}.icns`;
    const p = path.join(resDir, name);
    if (fs.existsSync(p)) return p;
  }
  try {
    const f = fs.readdirSync(resDir).find((x) => x.endsWith(".icns"));
    return f ? path.join(resDir, f) : null;
  } catch {
    return null;
  }
}

// macOS: returns the app icon as a 32px PNG data URL, cached in the temp directory.
function iconDataUrl(bundlePath) {
  const key = crypto.createHash("md5").update(bundlePath).digest("hex");
  const cached = path.join(ICONS_CACHE_DIR, `${key}.png`);
  if (!fs.existsSync(cached)) {
    const icns = findIcnsFile(bundlePath);
    if (!icns) return "";
    try {
      execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", "32", "32", icns, "--out", cached], {
        stdio: "ignore",
        timeout: 3000
      });
    } catch {
      return "";
    }
  }
  try {
    return "data:image/png;base64," + fs.readFileSync(cached).toString("base64");
  } catch {
    return "";
  }
}

async function queryLaunchServices(filePath) {
  ensureJxa();
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", JXA_PATH, filePath], {
    timeout: 5000
  });
  return JSON.parse(stdout);
}

async function listAppsForFileMac(filePath) {
  const { defaultPath, apps: raw } = await queryLaunchServices(filePath);
  const defNorm = defaultPath ? normalizeAppPath(defaultPath) : "";
  const entries = raw.map((r) => ({ path: normalizeAppPath(r.path), name: r.name }));
  entries.sort((a, b) => (b.path === defNorm) - (a.path === defNorm));

  const seen = new Set();
  const apps = [];
  for (const e of entries) {
    if (seen.has(e.path) || !isAllowedApp(e.path)) continue;
    seen.add(e.path);
    apps.push({ name: e.name, app: e.path, icon: iconDataUrl(e.path) });
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

// Windows: the registry lookup returns the default app first. Icons are extracted in one PowerShell run.
async function listAppsForFileWin(filePath) {
  const { defaultExe, apps: raw } = await win.listAppsWin(filePath);
  const sorted = [...raw].sort((a, b) => (b.exe === defaultExe) - (a.exe === defaultExe)).slice(0, MAX_APPS);
  const icons = await win.iconsWin(
    sorted.map((a) => a.exe),
    ICONS_CACHE_DIR
  );
  return sorted.map((a) => ({ name: a.name, app: a.exe, icon: icons.get(a.exe) || "" }));
}

// Apps that can open this file type, default app first. Cached per extension for a few minutes.
async function listAppsForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const key = ext || filePath;
  const hit = appListCache.get(key);
  if (hit && Date.now() - hit.at < APP_CACHE_TTL_MS) return hit.apps;

  let result;
  try {
    result = IS_WIN ? await listAppsForFileWin(filePath) : await listAppsForFileMac(filePath);
  } catch {
    return [];
  }
  appListCache.set(key, { at: Date.now(), apps: result });
  return result;
}

// Turns the stored last-used app into a menu entry. The stored value is a bundle path (macOS), an exe path (Windows),
// or an older bare name such as "Android Studio".
function resolveAppRef(ref, nameHint) {
  if (!ref || typeof ref !== "string") return null;
  if (IS_WIN) {
    if (!path.isAbsolute(ref) || !ref.toLowerCase().endsWith(".exe") || !fs.existsSync(ref)) return null;
    return { name: nameHint || path.basename(ref, ".exe"), app: ref, icon: "" };
  }
  let bundle = null;
  if (path.isAbsolute(ref)) {
    bundle = normalizeAppPath(ref);
  } else {
    for (const root of APP_ROOTS) {
      const p = path.join(root, `${ref}.app`);
      if (fs.existsSync(p)) {
        bundle = p;
        break;
      }
    }
  }
  if (!bundle || !fs.existsSync(bundle)) return null;
  return { name: nameHint || path.basename(bundle, ".app"), app: bundle, icon: iconDataUrl(bundle) };
}

async function getAvailableApps(filePath) {
  const fileApps = filePath ? await listAppsForFile(filePath) : [];
  const state = readState();
  const last = resolveAppRef(state.lastApp, state.lastAppName);
  if (last && IS_WIN && !last.icon) {
    const icons = await win.iconsWin([last.app], ICONS_CACHE_DIR);
    last.icon = icons.get(last.app) || "";
  }

  const merged = [];
  const seen = new Set();
  const keyOf = (app) => (IS_WIN ? app.toLowerCase() : app);
  const add = (a) => {
    if (!a) return;
    const k = keyOf(a.app);
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(a);
  };
  add(last);
  fileApps.forEach(add);
  merged.push({ name: "系统默认", app: "", icon: "" });

  return { apps: merged, lastApp: last ? last.app : "" };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {}
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "referrer-policy": "no-referrer"
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function resolveFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  let p = rawPath.trim();

  // Strip prefix/suffix artifacts
  if (p.startsWith("@/")) p = p.slice(1);
  if (p.startsWith("@")) p = p.slice(1);
  p = p.replace(/^<|>$/g, "");
  p = p.replace(/#L\d+(-L\d+)?$/, "").replace(/:\d+(-\d+)?$/, "");

  // Defensively reject API routes and web protocols
  if (/^\/?api(\/|$)/i.test(p) || /^(https?|ftp|file|ws|wss):/i.test(p)) {
    return null;
  }

  if (p.startsWith("~/") || p === "~") {
    p = path.join(os.homedir(), p.slice(1));
  } else if (!path.isAbsolute(p)) {
    const cwdCandidate = path.resolve(process.cwd(), p);
    if (fs.existsSync(cwdCandidate)) {
      p = cwdCandidate;
    } else {
      const defaultWs = path.join(os.homedir(), "Documents", "deepseek-harness", "default-workspace", p);
      if (fs.existsSync(defaultWs)) {
        p = defaultWs;
      } else {
        p = cwdCandidate;
      }
    }
  }
  return path.normalize(p);
}

export function apply(ctx) {
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register({
        kind: "prefix",
        path: BRIDGE_PREFIX,
        handler: async (req, res) => {
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "GET, POST, OPTIONS",
              "access-control-allow-headers": "content-type"
            });
            res.end();
            return;
          }

          const urlObj = new URL(req.url, "http://localhost");
          const subPath = urlObj.pathname.slice(BRIDGE_PREFIX.length);

          if (subPath === "/apps") {
            const filePath = resolveFilePath(urlObj.searchParams.get("path"));
            const existing = filePath && fs.existsSync(filePath) ? filePath : null;
            const { apps, lastApp } = await getAvailableApps(existing);
            writeJson(res, 200, { ok: true, apps, lastApp });
            return;
          }

          if (subPath === "/check") {
            const targetPath = resolveFilePath(urlObj.searchParams.get("path"));
            const exists = !!(targetPath && fs.existsSync(targetPath));
            writeJson(res, 200, { ok: true, exists, path: targetPath });
            return;
          }

          if (subPath === "/reveal") {
            const body = await readJsonBody(req);
            const targetPath = resolveFilePath(body.path);
            if (!targetPath || !fs.existsSync(targetPath)) {
              writeJson(res, 404, { ok: false, error: "文件不存在: " + (targetPath || body.path) });
              return;
            }
            try {
              if (IS_WIN) {
                await win.revealWin(targetPath);
              } else {
                await execAsync(`/usr/bin/open -R ${JSON.stringify(targetPath)}`);
              }
              writeJson(res, 200, { ok: true, path: targetPath });
            } catch (err) {
              writeJson(res, 500, { ok: false, error: err.message });
            }
            return;
          }

          if (subPath === "/open") {
            const body = await readJsonBody(req);
            const targetPath = resolveFilePath(body.path);
            if (!targetPath || !fs.existsSync(targetPath)) {
              writeJson(res, 404, { ok: false, error: "文件不存在: " + (targetPath || body.path) });
              return;
            }
            // On Windows the app must be an existing .exe, so the bridge cannot launch arbitrary paths.
            if (IS_WIN && body.app && !(body.app.toLowerCase().endsWith(".exe") && fs.existsSync(body.app))) {
              writeJson(res, 400, { ok: false, error: "应用不存在: " + body.app });
              return;
            }
            try {
              if (IS_WIN) {
                if (body.app) {
                  await win.openWithWin(body.app, targetPath);
                } else {
                  await win.openDefaultWin(targetPath);
                }
              } else if (body.app) {
                await execAsync(`/usr/bin/open -a ${JSON.stringify(body.app)} ${JSON.stringify(targetPath)}`);
              } else {
                await execAsync(`/usr/bin/open ${JSON.stringify(targetPath)}`);
              }
              if (body.app) writeState({ lastApp: body.app, lastAppName: typeof body.name === "string" ? body.name : "" });
              writeJson(res, 200, { ok: true, path: targetPath });
            } catch (err) {
              writeJson(res, 500, { ok: false, error: err.message });
            }
            return;
          }

          if (subPath === "/read") {
            const body = await readJsonBody(req);
            const targetPath = resolveFilePath(body.path);
            if (!targetPath || !fs.existsSync(targetPath)) {
              writeJson(res, 404, { ok: false, error: "文件不存在: " + (targetPath || body.path) });
              return;
            }
            try {
              const stat = await fs.promises.stat(targetPath);
              if (stat.isDirectory()) {
                writeJson(res, 400, { ok: false, error: "目标是目录，无法复制文本内容" });
                return;
              }
              if (stat.size > 5 * 1024 * 1024) {
                writeJson(res, 400, { ok: false, error: "文件大于 5MB，暂不支持一次性复制" });
                return;
              }
              const content = await fs.promises.readFile(targetPath, "utf8");
              writeJson(res, 200, { ok: true, content, length: content.length, path: targetPath });
            } catch (err) {
              writeJson(res, 500, { ok: false, error: err.message });
            }
            return;
          }

          if (subPath === "/save-as") {
            const body = await readJsonBody(req);
            const targetPath = resolveFilePath(body.path);
            if (!targetPath || !fs.existsSync(targetPath)) {
              writeJson(res, 404, { ok: false, error: "文件不存在: " + (targetPath || body.path) });
              return;
            }
            const baseName = path.basename(targetPath);
            try {
              let chosen = "";
              if (IS_WIN) {
                chosen = await win.saveAsWin(baseName);
              } else {
                const script = `set f to choose file name with prompt "另存为" default name ${JSON.stringify(baseName)}\nPOSIX path of f`;
                const { stdout } = await execAsync(`osascript -e ${JSON.stringify(script)}`);
                chosen = stdout.trim();
              }
              if (chosen) {
                await fs.promises.copyFile(targetPath, chosen);
                writeJson(res, 200, { ok: true, savedTo: chosen, baseName });
              } else {
                writeJson(res, 200, { ok: false, canceled: true });
              }
            } catch (err) {
              if (err.message && err.message.includes("User canceled")) {
                writeJson(res, 200, { ok: false, canceled: true });
              } else {
                writeJson(res, 500, { ok: false, error: err.message });
              }
            }
            return;
          }

          if (subPath === "/download") {
            const targetPath = resolveFilePath(urlObj.searchParams.get("path"));
            if (!targetPath || !fs.existsSync(targetPath)) {
              writeJson(res, 404, { ok: false, error: "文件不存在" });
              return;
            }
            const baseName = path.basename(targetPath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}`
            });
            fs.createReadStream(targetPath).pipe(res);
            return;
          }

          writeJson(res, 404, { ok: false, error: "未知操作" });
        }
      });

      return () => {
        if (typeof dispose === "function") dispose();
      };
    }, "dsh-file-menu: bridge route");
  });
}

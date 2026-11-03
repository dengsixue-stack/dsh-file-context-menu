// Windows side of the file menu backend. index.js picks these functions when process.platform is "win32".
// Scripts run through powershell.exe with -EncodedCommand. Paths and other values go in environment
// variables, never into the script text, so quotes and special characters in file names cannot break the command.
import { execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const PS_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-STA",
  "-WindowStyle",
  "Hidden",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand"
];

function getCleanEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Crucial: Electron sets ELECTRON_RUN_AS_NODE. If passed to Electron-based apps
  // like VS Code or Trae, they boot as CLI Node.js instead of opening their GUI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.NODE_OPTIONS;
  return env;
}

function runPs(script, env, timeout) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...PS_ARGS, encoded],
      { env: getCleanEnv(env), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    );
  });
}

// Lists the apps registered for a file extension: the user's choice first, then OpenWithProgids and OpenWithList.
const LIST_SCRIPT = String.raw`
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'SilentlyContinue'
$ext = $env:FCM_EXT
$base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext
$blocked = @('rundll32.exe', 'dllhost.exe', 'msiexec.exe')

function Get-ExeFromCommand([string]$cmd) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    if ($end -lt 2) { return $null }
    $exe = $c.Substring(1, $end - 1)
  } elseif ($c -match '^(\S+?\.exe)(\s|$)') {
    $exe = $Matches[1]
  } else { return $null }
  if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  return $null
}

function Get-ProgCommand([string]$progId) {
  $item = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $progId + '\shell\open\command') -ErrorAction SilentlyContinue
  if ($item) { return [string]$item.GetValue('') }
  return $null
}

function Get-ExeFromName([string]$name) {
  foreach ($root in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\')) {
    $it = Get-Item -LiteralPath ($root + $name) -ErrorAction SilentlyContinue
    if ($it) {
      $v = [Environment]::ExpandEnvironmentVariables([string]$it.GetValue(''))
      if ($v -and (Test-Path -LiteralPath $v -PathType Leaf)) { return $v }
    }
  }
  $cmd = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\Applications\' + $name + '\shell\open\command') -ErrorAction SilentlyContinue
  if ($cmd) { return Get-ExeFromCommand ([string]$cmd.GetValue('')) }
  return $null
}

$defaultProg = $null
$uc = Get-Item -LiteralPath ($base + '\UserChoice') -ErrorAction SilentlyContinue
if ($uc) { $defaultProg = [string]$uc.GetValue('ProgId') }

$progIds = New-Object System.Collections.Generic.List[string]
if ($defaultProg) { $progIds.Add($defaultProg) }
$owp = Get-Item -LiteralPath ($base + '\OpenWithProgids') -ErrorAction SilentlyContinue
if ($owp) {
  foreach ($n in $owp.GetValueNames()) {
    if ($n -and -not $progIds.Contains($n)) { $progIds.Add($n) }
  }
}

$exeNames = New-Object System.Collections.Generic.List[string]
$owl = Get-Item -LiteralPath ($base + '\OpenWithList') -ErrorAction SilentlyContinue
if ($owl) {
  foreach ($n in $owl.GetValueNames()) {
    if ($n -match '^[a-z]$') {
      $v = [string]$owl.GetValue($n)
      if ($v) { $exeNames.Add($v) }
    }
  }
}

$seen = @{}
$apps = New-Object System.Collections.ArrayList
$defaultExe = ''

function Add-App([string]$exe) {
  if (-not $exe) { return }
  if ($blocked -contains [System.IO.Path]::GetFileName($exe).ToLowerInvariant()) { return }
  $key = $exe.ToLowerInvariant()
  if ($script:seen.ContainsKey($key)) { return }
  $script:seen[$key] = $true
  $info = (Get-Item -LiteralPath $exe).VersionInfo
  $name = [string]$info.FileDescription
  if ([string]::IsNullOrWhiteSpace($name)) { $name = [System.IO.Path]::GetFileNameWithoutExtension($exe) }
  [void]$script:apps.Add(@{ exe = $exe; name = $name.Trim() })
}

foreach ($prog in $progIds) {
  $exe = Get-ExeFromCommand (Get-ProgCommand $prog)
  if ($exe) {
    if ($prog -eq $defaultProg -and -not $defaultExe) { $defaultExe = $exe }
    Add-App $exe
  }
}
foreach ($n in $exeNames) { Add-App (Get-ExeFromName $n) }

$result = @{ defaultExe = [string]$defaultExe; apps = @($apps.ToArray()) }
ConvertTo-Json -InputObject $result -Depth 4 -Compress
`;

// Writes one 32x32 PNG per job. Each job is { exe, out }.
const ICON_SCRIPT = String.raw`
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing
$jobs = @(ConvertFrom-Json -InputObject $env:FCM_ICON_JOBS)
foreach ($j in $jobs) {
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon([string]$j.exe)
    if ($null -eq $icon) { continue }
    $src = $icon.ToBitmap()
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, 32, 32)
    $g.Dispose()
    $bmp.Save([string]$j.out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $src.Dispose()
    $icon.Dispose()
  } catch {}
}
`;

// Shows the system save dialog. Prints the chosen path, or nothing when the user cancels.
const SAVE_SCRIPT = String.raw`
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size -ArgumentList 1, 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dlg = New-Object System.Windows.Forms.SaveFileDialog
$dlg.Title = '另存为'
$dlg.FileName = $env:FCM_DEFAULT_NAME
$dlg.Filter = 'All files (*.*)|*.*'
$dlg.OverwritePrompt = $true
$answer = $dlg.ShowDialog($owner)
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()
`;

// Opens a file with its default app, the same as double-clicking it in Explorer.
const OPEN_SCRIPT = String.raw`
[void][System.Diagnostics.Process]::Start($env:FCM_FILE)
`;

export async function listAppsWin(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return { defaultExe: "", apps: [] };
  const out = (await runPs(LIST_SCRIPT, { FCM_EXT: ext }, 15000)).trim();
  if (!out) return { defaultExe: "", apps: [] };
  const parsed = JSON.parse(out);
  const apps = Array.isArray(parsed.apps) ? parsed.apps : [];
  return { defaultExe: parsed.defaultExe || "", apps: apps.map((a) => ({ exe: a.exe, name: a.name })) };
}

function iconCachePath(cacheDir, exe) {
  return path.join(cacheDir, crypto.createHash("md5").update(exe).digest("hex") + ".png");
}

// Returns a Map from exe path to a PNG data URL. Missing icons are extracted in one PowerShell run.
export async function iconsWin(exePaths, cacheDir) {
  const jobs = exePaths
    .filter((exe) => !fs.existsSync(iconCachePath(cacheDir, exe)))
    .map((exe) => ({ exe, out: iconCachePath(cacheDir, exe) }));
  if (jobs.length > 0) {
    try {
      await runPs(ICON_SCRIPT, { FCM_ICON_JOBS: JSON.stringify(jobs) }, 20000);
    } catch {}
    // An empty file marks an icon that could not be extracted, so later requests do not retry it.
    for (const job of jobs) {
      if (!fs.existsSync(job.out)) {
        try {
          fs.writeFileSync(job.out, "");
        } catch {}
      }
    }
  }
  const result = new Map();
  for (const exe of exePaths) {
    try {
      const buf = fs.readFileSync(iconCachePath(cacheDir, exe));
      result.set(exe, buf.length > 0 ? "data:image/png;base64," + buf.toString("base64") : "");
    } catch {
      result.set(exe, "");
    }
  }
  return result;
}

// Returns the chosen path, or "" when the user cancels.
export async function saveAsWin(defaultName) {
  const out = await runPs(SAVE_SCRIPT, { FCM_DEFAULT_NAME: defaultName }, 0);
  return out.trim();
}

export function openDefaultWin(filePath) {
  return runPs(OPEN_SCRIPT, { FCM_FILE: filePath }, 10000).then(() => undefined);
}

export function openWithWin(appExe, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(appExe, [filePath], {
      detached: true,
      stdio: "ignore",
      env: getCleanEnv()
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// explorer.exe exits with code 1 even when the window opens, so only a spawn failure counts as an error.
export function revealWin(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [`/select,"${filePath}"`], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

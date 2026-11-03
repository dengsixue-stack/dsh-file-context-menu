window.__ModuleLoader__.load({
  id: "@dengsixue/dsh-file-menu",
  factory(require) {
    const exports = {};
    exports.name = "@dengsixue/dsh-file-menu";
    exports.inject = [];

    const BRIDGE_PREFIX = "/api/dsh-file-menu";
    // Menu wording for the system file browser: "在 Finder 中" on macOS, "在资源管理器中" on Windows.
    const REVEAL_IN = /Windows/i.test(navigator.userAgent || navigator.platform || "") ? "在资源管理器中" : "在 Finder 中";

    // Inject styles for the floating menu and toast
    function ensureStyles() {
      if (document.getElementById("dsh-file-context-menu-styles")) return;
      const style = document.createElement("style");
      style.id = "dsh-file-context-menu-styles";
      style.textContent = `
        .dsh-fcm-menu {
          position: fixed;
          z-index: 999999;
          min-width: 220px;
          background: rgba(249, 249, 251, 0.94);
          backdrop-filter: blur(40px) saturate(180%);
          -webkit-backdrop-filter: blur(40px) saturate(180%);
          border: 0.5px solid rgba(0, 0, 0, 0.14);
          border-radius: 8px;
          padding: 6px 0;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16), 0 1px 4px rgba(0, 0, 0, 0.08);
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
          font-size: 14px;
          line-height: 1.3;
          color: #1d1d1f;
          user-select: none;
          animation: dshFcmFadeIn 100ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @media (prefers-color-scheme: dark) {
          .dsh-fcm-menu {
            background: rgba(44, 44, 46, 0.94);
            border: 0.5px solid rgba(255, 255, 255, 0.16);
            color: #f5f5f7;
            box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5), 0 1px 4px rgba(0, 0, 0, 0.3);
          }
        }
        @keyframes dshFcmFadeIn {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
        .dsh-fcm-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 22px;
          padding: 3px 14px;
          margin: 0 5px;
          border-radius: 5px;
          cursor: default;
          position: relative;
          white-space: nowrap;
        }
        .dsh-fcm-item:hover, .dsh-fcm-item.active {
          background: #0a84ff;
          color: #ffffff;
        }
        .dsh-fcm-item-disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .dsh-fcm-item-disabled:hover {
          background: transparent;
          color: inherit;
        }
        .dsh-fcm-divider {
          height: 1px;
          background: rgba(0, 0, 0, 0.1);
          margin: 5px 14px;
        }
        @media (prefers-color-scheme: dark) {
          .dsh-fcm-divider {
            background: rgba(255, 255, 255, 0.12);
          }
        }
        .dsh-fcm-icon {
          width: 16px;
          height: 16px;
          margin-right: 8px;
          flex-shrink: 0;
          object-fit: contain;
        }
        .dsh-fcm-item .dsh-fcm-label {
          flex: 1;
        }
        .dsh-fcm-arrow {
          display: flex;
          align-items: center;
          margin-left: 16px;
          opacity: 0.7;
        }
        .dsh-fcm-item:hover .dsh-fcm-arrow {
          opacity: 1;
        }
        .dsh-fcm-submenu {
          position: absolute;
          top: -5px;
          left: calc(100% - 2px);
          display: none;
        }
        .dsh-fcm-submenu.left {
          left: auto;
          right: calc(100% - 2px);
        }
        .dsh-fcm-submenu::before {
          content: "";
          position: absolute;
          top: -10px;
          bottom: -10px;
          left: -14px;
          width: 18px;
          background: transparent;
        }
        .dsh-fcm-submenu.left::before {
          left: auto;
          right: -14px;
          width: 18px;
        }
        .dsh-fcm-item:hover > .dsh-fcm-submenu,
        .dsh-fcm-submenu.dsh-fcm-visible {
          display: block;
        }
        .dsh-fcm-toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 1000000;
          background: rgba(20, 20, 22, 0.86);
          color: #ffffff;
          padding: 8px 16px;
          border-radius: 20px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
          font-size: 13px;
          font-weight: 500;
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          pointer-events: none;
          animation: dshFcmToastIn 160ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes dshFcmToastIn {
          from { opacity: 0; transform: translate(-50%, 8px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `;
      document.head.appendChild(style);
    }

    let currentMenu = null;
    let toastTimeout = null;
    let cachedApps = null;

    function showToast(message) {
      if (toastTimeout) clearTimeout(toastTimeout);
      const old = document.querySelector(".dsh-fcm-toast");
      if (old) old.remove();

      const toast = document.createElement("div");
      toast.className = "dsh-fcm-toast";
      toast.textContent = message;
      document.body.appendChild(toast);

      toastTimeout = setTimeout(() => {
        toast.style.transition = "opacity 200ms";
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 200);
      }, 2000);
    }

    async function copyToClipboard(text) {
      if (!text && text !== "") return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
      } catch {}
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        ta.remove();
      }
    }

    function closeMenu() {
      if (currentMenu) {
        currentMenu.remove();
        currentMenu = null;
      }
    }

    // Returns { apps, lastApp }. Not cached, so the "last used" app is always current.
    async function loadApps(filePath) {
      try {
        const res = await fetch(`${BRIDGE_PREFIX}/apps?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.ok && Array.isArray(data.apps)) {
          return { apps: data.apps, lastApp: data.lastApp || "" };
        }
      } catch {}
      return { apps: [{ name: "系统默认", app: "", icon: "" }], lastApp: "" };
    }

    function makeIcon(src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.width = 16;
      img.height = 16;
      img.className = "dsh-fcm-icon";
      return img;
    }

    // Precise path validation: must be a local file path, NEVER an API route or URL
    function isGenuineFilePath(str) {
      if (!str || typeof str !== "string") return false;
      const s = str.trim();
      if (s.length < 2 || s.length > 600) return false;
      if (s.includes("\n") || s.includes("\r")) return false;

      // 1. Defensively reject web protocols, API endpoints, and hosts
      if (/^(https?|ftp|file|ws|wss|blob|data):/i.test(s)) return false;
      if (/^\/?api(\/|$)/i.test(s)) return false;
      if (/^\/?v\d+(\/|$)/i.test(s)) return false;
      if (/^127\.0\.0\.1|^localhost/i.test(s)) return false;

      // 2. Reject CLI options and pure syntax symbols
      if (/^--?[a-zA-Z]/.test(s)) return false;
      if (/^[\/\\]{2,}/.test(s)) return false;
      if (/^[\*\+\~\#\!\$\%\^\&\(\)\=\{\}\[\]\|:;\"\'<>,]+$/.test(s)) return false;

      // 3. Absolute filesystem paths on macOS / Linux
      if (/^\/(Users|System|Applications|Library|Volumes|tmp|private|opt|usr|var)\b/.test(s)) {
        return true;
      }

      // 4. Home and workspace alias prefix
      if (s.startsWith("~/") || s.startsWith("@/")) {
        return true;
      }

      // 5. Windows drive letter paths
      if (/^[a-zA-Z]:[\\/]/.test(s)) {
        return true;
      }

      // 6. Paths with recognized file extensions
      const clean = s.split(/[?#]/)[0];
      const extMatch = clean.match(/\.([a-zA-Z0-9_-]{1,12})$/);
      if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        const webTlds = ["com", "cn", "org", "net", "io", "ai", "co", "me", "dev", "app", "site", "xyz", "info"];
        if (webTlds.includes(ext) && !s.includes("/") && !s.includes("\\")) {
          return false;
        }
        return true;
      }

      return false;
    }

    function cleanPath(str) {
      if (!str) return "";
      let s = str.trim();
      if (s.startsWith("@/")) s = s.slice(1);
      if (s.startsWith("@")) s = s.slice(1);
      s = s.replace(/^<|>$/g, "");
      s = s.replace(/#L\d+(-L\d+)?$/, "").replace(/:\d+(-\d+)?$/, "");
      return s;
    }

    function getCleanLinkText(el) {
      if (!el) return "";
      try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("svg, img, [class*='linkIcon'], [class*='previewName']").forEach((n) => n.remove());
        const txt = (clone.innerText || clone.textContent || "").trim();
        if (txt) return txt.replace(/\s+/g, " ");
      } catch {}
      return (el.textContent || "").trim().replace(/\s+/g, " ");
    }

    // Only extract file paths from actual file links, buttons, or chips.
    // Does NOT intercept general text to preserve 100% native right click!
    function extractFileInfo(target) {
      if (!target || !(target instanceof Element)) return null;

      // 1. DSH file hyperlinks and file chip buttons
      // File-edit card ("已编辑 README.md"): the path is in aria-label as "查看 <path> 的改动".
      const editCard = target.closest('button[aria-label^="查看 "][aria-label$=" 的改动"]');
      if (editCard) {
        const m = (editCard.getAttribute("aria-label") || "").match(/^查看 (.+) 的改动$/);
        if (m && isGenuineFilePath(m[1])) {
          const filePath = cleanPath(m[1]);
          return { filePath, linkText: filePath.split(/[\\/]/).pop() };
        }
      }

      const fileEl = target.closest('button[class*="fileLink"], button[class*="fileMention"], [data-ref-chip="file"]');
      if (fileEl) {
        const title = fileEl.getAttribute("title") || fileEl.getAttribute("aria-label");
        const href = fileEl.getAttribute("href");
        const linkText = getCleanLinkText(fileEl);

        if (title && isGenuineFilePath(title)) {
          return {
            filePath: cleanPath(title),
            linkText: linkText || cleanPath(title).split(/[\\/]/).pop()
          };
        }

        if (href && isGenuineFilePath(href)) {
          return {
            filePath: cleanPath(href),
            linkText: linkText || cleanPath(href).split(/[\\/]/).pop()
          };
        }

        if (linkText && isGenuineFilePath(linkText)) {
          return {
            filePath: cleanPath(linkText),
            linkText: linkText
          };
        }
      }

      // 2. Anchor tags pointing to file:// or local paths
      const anchor = target.closest("a");
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        const text = (anchor.innerText || anchor.textContent || "").trim();
        if (href.startsWith("file://")) {
          const p = decodeURIComponent(href.slice(7));
          if (isGenuineFilePath(p)) {
            return {
              filePath: cleanPath(p),
              linkText: text || p.split(/[\\/]/).pop()
            };
          }
        }
        if (isGenuineFilePath(href)) {
          return {
            filePath: cleanPath(href),
            linkText: text || href.split(/[\\/]/).pop()
          };
        }
      }

      return null;
    }

    async function handleFileAction(action, filePath, extra = {}) {
      closeMenu();
      try {
        if (action === "copy-link-text") {
          const text = extra.linkText || filePath.split(/[\\/]/).pop() || "";
          await copyToClipboard(text);
          showToast(text.length <= 25 ? `已复制链接文本: ${text}` : "已复制链接文本");
          return;
        }

        if (action === "copy-path") {
          await copyToClipboard(filePath);
          showToast("已复制路径");
          return;
        }

        if (action === "copy-content") {
          const res = await fetch(`${BRIDGE_PREFIX}/read`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: filePath })
          });
          const data = await res.json();
          if (data.ok) {
            await copyToClipboard(data.content);
            showToast(`已复制文件内容 (${data.length} 字符)`);
          } else {
            showToast(data.error || "读取文件失败");
          }
          return;
        }

        if (action === "reveal") {
          const res = await fetch(`${BRIDGE_PREFIX}/reveal`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: filePath })
          });
          const data = await res.json();
          if (data.ok) {
            showToast(`已${REVEAL_IN}显示`);
          } else {
            showToast(data.error || `无法${REVEAL_IN}显示`);
          }
          return;
        }

        if (action === "open") {
          const res = await fetch(`${BRIDGE_PREFIX}/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: filePath, app: extra.app, name: extra.name })
          });
          const data = await res.json();
          if (data.ok) {
            showToast(`正在打开...`);
          } else {
            showToast(data.error || "打开失败");
          }
          return;
        }

        if (action === "save-as") {
          const res = await fetch(`${BRIDGE_PREFIX}/save-as`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: filePath })
          });
          const data = await res.json();
          if (data.ok) {
            showToast(`已另存为: ${data.baseName}`);
          } else if (data.canceled) {
            // User canceled dialog, do nothing
          } else {
            // Fallback to browser download
            const a = document.createElement("a");
            a.href = `${BRIDGE_PREFIX}/download?path=${encodeURIComponent(filePath)}`;
            a.download = filePath.split(/[\\/]/).pop();
            a.click();
          }
          return;
        }
      } catch (err) {
        showToast("操作出错: " + err.message);
      }
    }

    async function createMenu(x, y, fileInfo) {
      ensureStyles();
      closeMenu();

      const { filePath, linkText } = fileInfo;
      const menu = document.createElement("div");
      menu.className = "dsh-fcm-menu";

      const { apps, lastApp } = await loadApps(filePath);
      const lastEntry = apps.find((a) => a.app === lastApp && a.app !== "");

      // 1. Top item: re-open with the app used last time, like Codex does.
      if (lastEntry) {
        const lastItem = document.createElement("div");
        lastItem.className = "dsh-fcm-item";
        if (lastEntry.icon) lastItem.appendChild(makeIcon(lastEntry.icon));
        const label = document.createElement("span");
        label.className = "dsh-fcm-label";
        label.textContent = `在 ${lastEntry.name} 中打开`;
        lastItem.appendChild(label);
        lastItem.addEventListener("click", () => handleFileAction("open", filePath, { app: lastEntry.app, name: lastEntry.name }));
        menu.appendChild(lastItem);

        const topDiv = document.createElement("div");
        topDiv.className = "dsh-fcm-divider";
        menu.appendChild(topDiv);
      }

      // 2. 打开方式 with submenu, last-used app listed first
      const openWithItem = document.createElement("div");
      openWithItem.className = "dsh-fcm-item";
      openWithItem.innerHTML = `<span class="dsh-fcm-label">打开方式</span><span class="dsh-fcm-arrow"><svg width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"><path d="M1.5 1.5 6 6 1.5 10.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

      const submenu = document.createElement("div");
      submenu.className = "dsh-fcm-menu dsh-fcm-submenu";
      openWithItem.appendChild(submenu);

      let subTimer = null;
      const showSub = () => {
        if (subTimer) { clearTimeout(subTimer); subTimer = null; }
        submenu.classList.add("dsh-fcm-visible");
        openWithItem.classList.add("active");
      };
      const hideSub = () => {
        if (subTimer) clearTimeout(subTimer);
        subTimer = setTimeout(() => {
          submenu.classList.remove("dsh-fcm-visible");
          openWithItem.classList.remove("active");
        }, 280);
      };

      openWithItem.addEventListener("mouseenter", showSub);
      openWithItem.addEventListener("mouseleave", hideSub);
      submenu.addEventListener("mouseenter", showSub);
      submenu.addEventListener("mouseleave", hideSub);

      const ordered = lastEntry ? [lastEntry, ...apps.filter((a) => a !== lastEntry)] : apps;
      ordered.forEach((appItem) => {
        const subItem = document.createElement("div");
        subItem.className = "dsh-fcm-item";
        if (appItem.icon) subItem.appendChild(makeIcon(appItem.icon));
        const label = document.createElement("span");
        label.className = "dsh-fcm-label";
        label.textContent = appItem.name;
        subItem.appendChild(label);
        subItem.addEventListener("click", (e) => {
          e.stopPropagation();
          handleFileAction("open", filePath, { app: appItem.app, name: appItem.name });
        });
        submenu.appendChild(subItem);
      });

      menu.appendChild(openWithItem);

      // 2. 另存为...
      const saveAsItem = document.createElement("div");
      saveAsItem.className = "dsh-fcm-item";
      saveAsItem.textContent = "另存为...";
      saveAsItem.addEventListener("click", () => handleFileAction("save-as", filePath));
      menu.appendChild(saveAsItem);

      // Divider
      const div1 = document.createElement("div");
      div1.className = "dsh-fcm-divider";
      menu.appendChild(div1);

      // 3. 复制链接文本
      const copyLinkTextItem = document.createElement("div");
      copyLinkTextItem.className = "dsh-fcm-item";
      copyLinkTextItem.textContent = "复制链接文本";
      copyLinkTextItem.addEventListener("click", () => handleFileAction("copy-link-text", filePath, { linkText }));
      menu.appendChild(copyLinkTextItem);

      // 4. 复制路径
      const copyPathItem = document.createElement("div");
      copyPathItem.className = "dsh-fcm-item";
      copyPathItem.textContent = "复制路径";
      copyPathItem.addEventListener("click", () => handleFileAction("copy-path", filePath));
      menu.appendChild(copyPathItem);

      // 5. 复制文件内容
      const copyContentItem = document.createElement("div");
      copyContentItem.className = "dsh-fcm-item";
      copyContentItem.textContent = "复制文件内容";
      copyContentItem.addEventListener("click", () => handleFileAction("copy-content", filePath));
      menu.appendChild(copyContentItem);

      // Divider
      const div2 = document.createElement("div");
      div2.className = "dsh-fcm-divider";
      menu.appendChild(div2);

      // 6. 在 Finder 中显示
      const revealItem = document.createElement("div");
      revealItem.className = "dsh-fcm-item";
      revealItem.textContent = `${REVEAL_IN}显示`;
      revealItem.addEventListener("click", () => handleFileAction("reveal", filePath));
      menu.appendChild(revealItem);

      // Sibling items clear submenu when intentionally hovered
      [saveAsItem, copyLinkTextItem, copyPathItem, copyContentItem, revealItem].forEach((it) => {
        if (!it) return;
        it.addEventListener("mouseenter", () => {
          if (subTimer) clearTimeout(subTimer);
          subTimer = setTimeout(() => {
            submenu.classList.remove("dsh-fcm-visible");
            openWithItem.classList.remove("active");
          }, 80);
        });
      });

      document.body.appendChild(menu);
      currentMenu = menu;

      // Position adjustment
      const menuRect = menu.getBoundingClientRect();
      let left = x;
      let top = y;

      if (left + menuRect.width > window.innerWidth - 10) {
        left = window.innerWidth - menuRect.width - 10;
      }
      if (top + menuRect.height > window.innerHeight - 10) {
        top = window.innerHeight - menuRect.height - 10;
      }
      menu.style.left = `${Math.max(10, left)}px`;
      menu.style.top = `${Math.max(10, top)}px`;

      // Submenu direction check
      if (left + menuRect.width + 175 > window.innerWidth) {
        submenu.classList.add("left");
      }
    }

    exports.apply = function(ctx) {
      ensureStyles();

      // Intercept contextmenu in capture phase
      window.addEventListener("contextmenu", (event) => {
        // If Shift key is held down, allow native context menu unconditionally!
        if (event.shiftKey) {
          closeMenu();
          return;
        }

        const fileInfo = extractFileInfo(event.target);
        if (fileInfo) {
          event.preventDefault();
          event.stopPropagation();
          createMenu(event.clientX, event.clientY, fileInfo);
        } else {
          // Normal right-click on non-file areas: do NOT preventDefault!
          closeMenu();
        }
      }, true);

      // Close on outside clicks or Escape
      window.addEventListener("click", (e) => {
        if (currentMenu && !currentMenu.contains(e.target)) {
          closeMenu();
        }
      }, true);

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
      });

      window.addEventListener("blur", closeMenu);
    };

    return exports;
  }
});

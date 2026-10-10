/**
 * Web-build bridge — installs the browser implementations for the native
 * dialogs the app calls (`plugin:dialog|open|save`) and exports the
 * `isWeb` flag the UI branches on.
 *
 * The fetch-based `invoke()` shim itself lives in `src/app.html` (it must
 * run before the app bundle). This module runs with the app and provides
 * what needs real UI:
 *
 *   • Folder picker (`open({directory:true})`) — mobile browsers have no
 *     directory picker, so we render an in-app file browser backed by the
 *     server-side `web_list_dir` command. Great on Termux, where the
 *     filesystem is the phone's own home.
 *   • Save dialog — resolves `null` (cancel) by default; the web-mode
 *     code paths that need saving (Agentfile export) use the dedicated
 *     `web_loadout_export` command + a browser download instead.
 */

/** True when running as the web build (no Tauri host). */
export const isWeb: boolean =
  typeof window !== "undefined" && (window as { __AGENCY_WEB__?: boolean }).__AGENCY_WEB__ === true;

interface DialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

interface WebDialogs {
  open: (options?: DialogOptions) => Promise<string | string[] | null>;
  save: (options?: DialogOptions) => Promise<string | null>;
}

interface DirEntry {
  name: string;
  dir: boolean;
  symlink: boolean;
}

interface ListDirResult {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

declare global {
  interface Window {
    __AGENCY_WEB__?: boolean;
    __AGENCY_WEB_DIALOG__?: WebDialogs;
  }
}

/** POST to the HTTP invoke bridge (same wire format as the app.html shim). */
async function bridgeInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw body ?? { code: "internal", message: `HTTP ${res.status}` };
  return body as T;
}

/** Trigger a browser download of a JSON string as a file. */
export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** Read a local file the user picked (upload-style) as text. */
export function pickFileAsText(accept = "application/json,.json"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Folder picker overlay
// ---------------------------------------------------------------------------

const PICKER_Z = 2147483000;

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * The in-app directory browser. Promise resolves with the chosen absolute
 * path, or null when cancelled. Self-contained DOM (no Svelte) so it can be
 * mounted from anywhere, styled with the app's design tokens.
 */
function pickFolder(title: string, startPath?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", title);
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: String(PICKER_Z),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgb(0 0 0 / 0.45)",
      padding: "16px",
      boxSizing: "border-box",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);

    const box = document.createElement("div");
    Object.assign(box.style, {
      width: "min(560px, 100%)",
      maxHeight: "min(80vh, 640px)",
      display: "flex",
      flexDirection: "column",
      background: css("--color-surface-raised", "#fff"),
      color: css("--color-text-primary", "#111"),
      border: `1px solid ${css("--color-border-strong", "#999")}`,
      borderRadius: "14px",
      boxShadow: css("--shadow-modal", "0 25px 50px -12px rgb(0 0 0 / 0.25)"),
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);
    root.appendChild(box);

    // Header: title + close.
    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "14px 16px",
      borderBottom: `1px solid ${css("--color-border", "#ddd")}`,
    } satisfies Partial<CSSStyleDeclaration>);
    const h = document.createElement("h2");
    h.textContent = title;
    Object.assign(h.style, { margin: "0", fontSize: "15px", flex: "1", fontWeight: "600" });
    const closeBtn = mkBtn("✕", css("--color-text-muted", "#777"), () => done(null));
    closeBtn.setAttribute("aria-label", "Close");
    head.append(h, closeBtn);
    box.appendChild(head);

    // Path bar: up + current path (tap-to-edit for direct entry).
    const pathRow = document.createElement("div");
    Object.assign(pathRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "10px 16px",
      borderBottom: `1px solid ${css("--color-border", "#ddd")}`,
    } satisfies Partial<CSSStyleDeclaration>);
    const upBtn = mkBtn("↑", css("--color-text-secondary", "#555"), () => {
      if (current.parent) void load(current.parent);
    });
    upBtn.setAttribute("aria-label", "Parent folder");
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.spellcheck = false;
    Object.assign(pathInput.style, {
      flex: "1",
      minWidth: "0",
      padding: "6px 10px",
      borderRadius: "8px",
      border: `1px solid ${css("--color-border", "#ddd")}`,
      background: css("--color-surface-sunken", "#f4f4f4"),
      color: css("--color-text-primary", "#111"),
      fontSize: "13px",
      fontVariantNumeric: "tabular-nums",
    } satisfies Partial<CSSStyleDeclaration>);
    pathInput.onkeydown = (e) => {
      if (e.key === "Enter") void load(pathInput.value.trim());
    };
    pathRow.append(upBtn, pathInput);
    box.appendChild(pathRow);

    // Entry list.
    const list = document.createElement("div");
    Object.assign(list.style, {
      flex: "1",
      minHeight: "200px",
      overflowY: "auto",
      padding: "8px",
    } satisfies Partial<CSSStyleDeclaration>);
    list.style.setProperty("-webkit-overflow-scrolling", "touch");
    box.appendChild(list);

    // Footer: cancel + choose.
    const foot = document.createElement("div");
    Object.assign(foot.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
      padding: "12px 16px",
      borderTop: `1px solid ${css("--color-border", "#ddd")}`,
    } satisfies Partial<CSSStyleDeclaration>);
    const status = document.createElement("span");
    Object.assign(status.style, {
      fontSize: "12px",
      color: css("--color-text-muted", "#777"),
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    const cancelBtn = mkBtn("Cancel", css("--color-text-secondary", "#555"), () => done(null));
    const chooseBtn = mkBtn(
      "Choose this folder",
      "#fff",
      () => done(current.path),
      css("--color-brand", "#c2703a"),
    );
    foot.append(status, cancelBtn, chooseBtn);
    box.appendChild(foot);

    let current: ListDirResult = { path: "", parent: null, entries: [] };
    let disposed = false;

    function done(value: string | null) {
      if (disposed) return;
      disposed = true;
      root.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") done(null);
    }
    document.addEventListener("keydown", onKey);

    function mkBtn(
      text: string,
      color: string,
      onClick: () => void,
      bg = "transparent",
    ): HTMLButtonElement {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.onclick = onClick;
      Object.assign(b.style, {
        padding: "7px 12px",
        borderRadius: "8px",
        border: bg === "transparent" ? `1px solid ${css("--color-border", "#ddd")}` : "none",
        background: bg,
        color: bg === "transparent" ? color : color,
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        whiteSpace: "nowrap",
      } satisfies Partial<CSSStyleDeclaration>);
      return b;
    }

    async function load(dir: string) {
      status.textContent = "Loading…";
      list.textContent = "";
      try {
        const res = await bridgeInvoke<ListDirResult>("web_list_dir", { path: dir });
        if (disposed) return;
        current = res;
        pathInput.value = res.path;
        status.textContent = `${res.entries.filter((e) => e.dir).length} folders`;
        renderEntries(res);
      } catch (e) {
        if (disposed) return;
        status.textContent =
          (e as { message?: string })?.message ?? "Could not open that folder";
      }
    }

    function renderEntries(res: ListDirResult) {
      for (const ent of res.entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.textContent = (ent.dir ? "📁 " : "📄 ") + ent.name;
        row.disabled = !ent.dir;
        Object.assign(row.style, {
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: "8px",
          padding: "9px 10px",
          borderRadius: "8px",
          border: "none",
          background: "transparent",
          color: ent.dir
            ? css("--color-text-primary", "#111")
            : css("--color-text-muted", "#999"),
          fontSize: "14px",
          textAlign: "left" as const,
          cursor: ent.dir ? "pointer" : "default",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        } satisfies Partial<CSSStyleDeclaration>);
        if (ent.dir) row.onclick = () => void load(res.path + "/" + ent.name);
        list.appendChild(row);
      }
      if (res.entries.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "Empty folder";
        Object.assign(empty.style, {
          padding: "18px 10px",
          fontSize: "13px",
          color: css("--color-text-muted", "#999"),
          textAlign: "center",
        } satisfies Partial<CSSStyleDeclaration>);
        list.appendChild(empty);
      }
    }

    document.body.appendChild(root);
    void load(startPath ?? "");
  });
}

/** Install the dialog implementations the app.html shim delegates to. */
export function installWebDialogs(): void {
  if (!isWeb) return;
  window.__AGENCY_WEB_DIALOG__ = {
    async open(options) {
      if (options?.directory) {
        const p = await pickFolder(options.title ?? "Choose a folder");
        return options.multiple ? (p ? [p] : null) : p;
      }
      // File open: the only file-open call site (Agentfile import) branches
      // on isWeb and uses pickFileAsText instead; reject loudly if anything
      // else ever hits this so the gap is obvious rather than silent.
      throw {
        code: "internal",
        message: "File picking is handled per-feature in the web build (see webBridge.ts).",
      };
    },
    async save() {
      // The web build downloads exports in the browser instead.
      return null;
    },
  };
}

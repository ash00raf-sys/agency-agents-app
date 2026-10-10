<script lang="ts">
  /**
   * Chat — talk to any catalog agent through OpenRouter (web build).
   * The agent's markdown persona is the system prompt; replies stream in
   * over SSE from `POST /api/chat`. Conversations live in localStorage;
   * usage totals live in the backend journal. DevForge keeps the coding
   * lanes — this is the persona-conversation surface.
   */
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { isWeb } from "$lib/util/platform";
  import { errorText, type Agent } from "$lib/types";
  import { chat } from "$lib/stores/chat.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { projects } from "$lib/stores/projects.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import Send from "@lucide/svelte/icons/send";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Check from "@lucide/svelte/icons/check";
  import FileDiff from "@lucide/svelte/icons/file-diff";

  let draft = $state("");
  let keyInput = $state("");
  let agentCache = new Map<string, Agent>();

  onMount(() => {
    void chat.load();
  });

  const active = $derived(chat.active);
  const convs = $derived(chat.conversations);

  /** Full agent record (with body) for the system prompt. */
  async function agentFor(slug: string): Promise<Agent | null> {
    if (agentCache.has(slug)) return agentCache.get(slug) ?? null;
    try {
      const a = await invoke<Agent>("corpus_get", { slug });
      agentCache.set(slug, a);
      return a;
    } catch {
      return null;
    }
  }

  /** The persona markdown becomes the system prompt. */
  async function systemFor(slug: string): Promise<string> {
    const a = await agentFor(slug);
    if (!a) return "You are a helpful AI agent.";
    const head = [a.description, a.vibe].filter(Boolean).join("\n\n");
    return `You are ${a.name}, an AI agent.${head ? `\n\n${head}` : ""}\n\n---\n\n${a.body ?? ""}`;
  }

  // ── Project workspace context (inspect & alter) ────────────────────────
  // An attached project gives the agent its file tree + attached files, plus
  // the edit protocol: changed files come back as ```path:<rel> fences which
  // the UI renders with Apply buttons (diff preview → confirm → backup+write).

  type TreeEntry = { p: string; d: 0 | 1 };
  let treeEntries = $state<TreeEntry[]>([]);
  let treeLoading = $state(false);
  let projectPicker = $state(false); // project selector modal
  let filePicker = $state(false); // attach-files modal
  /** messageIndex:rel → applied (ephemeral; re-Apply after reload is safe). */
  let applied = $state<Set<string>>(new Set());

  const KEY_FILES = [
    "README.md",
    "package.json",
    "index.html",
    "build.gradle",
    "app/build.gradle",
    "settings.gradle",
    "app/src/main/AndroidManifest.xml",
  ];

  async function loadTree(path: string) {
    treeLoading = true;
    try {
      const res = await invoke<{ entries: TreeEntry[] }>("workspace_tree", { path });
      treeEntries = res.entries;
    } catch {
      treeEntries = [];
    } finally {
      treeLoading = false;
    }
  }

  /** Auto-attach the first existing key files (max 3) beyond user picks. */
  function autoFiles(): string[] {
    const picked = active?.attachedFiles ?? [];
    const names = new Set(treeEntries.filter((e) => !e.d).map((e) => e.p));
    return KEY_FILES.filter((k) => names.has(k) && !picked.includes(k)).slice(0, 3);
  }

  /** Build the workspace context block appended to the system prompt. */
  async function projectContext(path: string, label: string): Promise<string> {
    await loadTree(path);
    const rels = [...(active?.attachedFiles ?? []), ...autoFiles()];
    const files: string[] = [];
    let budget = 120_000;
    for (const rel of rels) {
      if (budget <= 0) break;
      try {
        const r = await invoke<{ text: string | null; binary: boolean; truncated: boolean }>(
          "workspace_read",
          { path, file: rel },
        );
        if (r.binary) {
          files.push(`=== ${rel} === (binary, not included)`);
          continue;
        }
        const text = r.text ?? "";
        const capped = text.slice(0, budget);
        budget -= capped.length;
        files.push(`=== ${rel} ===\n${capped}${r.truncated ? "\n… (truncated)" : ""}`);
      } catch {
        files.push(`=== ${rel} === (unreadable)`);
      }
    }
    const tree = treeEntries
      .map((e) => (e.d ? `${e.p}/` : e.p))
      .slice(0, 200)
      .join("\n");
    return [
      `WORKSPACE: "${label}" at ${path}`,
      ``,
      `File tree (top of project; junk dirs omitted):`,
      tree || "(empty)",
      ``,
      ...(files.length ? [`Attached files:`, ...files.map((f) => `\n${f}`), ``] : []),
      `EDIT PROTOCOL — follow exactly when changing or creating files:`,
      `1. Output the complete new content of each changed file in a fenced code`,
      `   block whose info string is "path:<relative path>", e.g.:`,
      "```path:src/app.js",
      `<complete file content>`,
      "```",
      `2. Use paths relative to the project root. One block per file.`,
      `3. Outside code blocks, keep explanations brief.`,
      `4. The user reviews a diff and applies your changes — nothing touches`,
      `   disk until they confirm.`,
    ].join("\n");
  }

  async function submit() {
    const conv = active;
    const text = draft.trim();
    if (!conv || !text || chat.streaming) return;
    draft = "";
    try {
      let system = await systemFor(conv.slug);
      if (conv.projectPath && conv.projectLabel) {
        const ctx = await projectContext(conv.projectPath, conv.projectLabel);
        system = `${system}\n\n---\n\n${ctx}`;
      }
      await chat.send(conv.slug, system, text, conv.model ?? chat.key.model);
    } catch {
      /* chat.error carries the message */
    }
  }

  // ── Apply-to-file: parse ```path: fences, diff, confirm, write ────────
  interface FileBlock {
    path: string;
    content: string;
    lines: number;
  }

  function blocksOf(content: string): FileBlock[] {
    const out: FileBlock[] = [];
    const re = /```path:([^\n`]+)\n([\s\S]*?)(?:```|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const content2 = m[2] ?? "";
      if (content2.trim() !== "") out.push({ path: m[1].trim(), content: content2, lines: content2.split("\n").length });
    }
    return out;
  }

  function messageBlocks(_i: number, content: string): FileBlock[] {
    if (!active?.projectPath) return [];
    return blocksOf(content);
  }

  let diffFor = $state<{ block: FileBlock; msgIndex: number } | null>(null);
  let diffData = $state<{ diff: string; summary: string; exists: boolean; identical: boolean } | null>(null);
  let diffBusy = $state(false);
  let applyBusy = $state(false);

  async function openDiff(block: FileBlock, msgIndex: number) {
    if (!active?.projectPath) return;
    diffFor = { block, msgIndex };
    diffData = null;
    diffBusy = true;
    try {
      diffData = await invoke<typeof diffData>("workspace_diff", {
        path: active.projectPath,
        file: block.path,
        content: block.content,
      });
    } catch (e) {
      diffData = { diff: errorText(e), summary: "could not compute diff", exists: false, identical: false };
    } finally {
      diffBusy = false;
    }
  }

  async function applyFile() {
    if (!diffFor || !active?.projectPath || applyBusy) return;
    applyBusy = true;
    try {
      const r = await invoke<{ created: boolean; backup: string | null }>("workspace_write", {
        path: active.projectPath,
        file: diffFor.block.path,
        content: diffFor.block.content,
      });
      const key = `${diffFor.msgIndex}:${diffFor.block.path}`;
      applied = new Set(applied).add(key);
      toast.success(
        i18n.optional("chat.applied", `Applied ${diffFor.block.path}`),
        r.created
          ? i18n.optional("chat.appliedCreated", "File created.")
          : i18n.optional("chat.appliedBackup", "Previous version backed up."),
      );
      diffFor = null;
    } catch (e) {
      toast.error(i18n.optional("chat.applyFailed", "Could not apply file"), errorText(e));
    } finally {
      applyBusy = false;
    }
  }

  function isApplied(msgIndex: number, rel: string): boolean {
    return applied.has(`${msgIndex}:${rel}`);
  }

  function pickProject(path: string, label: string) {
    if (!active) return;
    chat.attachProject(active.slug, path, label);
    projectPicker = false;
    void loadTree(path);
  }

  function toggleAttach(rel: string) {
    if (!active) return;
    const cur = active.attachedFiles ?? [];
    chat.setAttachedFiles(active.slug, cur.includes(rel) ? cur.filter((f) => f !== rel) : [...cur, rel]);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  async function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    try {
      await chat.saveKey(k);
      keyInput = "";
    } catch {
      /* chat.error shown inline */
    }
  }

  function fmtCost(usd: number | undefined): string {
    if (!usd) return "";
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }
</script>

{#if !isWeb}
  <div class="chat-empty">
    <MessageSquare size={28} />
    <p>{i18n.optional("chat.webOnly", "Agent chat is available in the web build.")}</p>
  </div>
{:else if !chat.key.configured}
  <div class="chat-setup">
    <KeyRound size={22} />
    <h2>{i18n.optional("chat.setupTitle", "Talk to your agents")}</h2>
    <p class="hint">
      {i18n.optional(
        "chat.setupHint",
        "Chat runs on your OpenRouter key — the same one DevForge uses. It's stored only on this device and never shown again.",
      )}
    </p>
    <input
      type="password"
      placeholder="sk-or-v1-…"
      bind:value={keyInput}
      onkeydown={(e) => e.key === "Enter" && saveKey()}
    />
    <button class="primary" disabled={!keyInput.trim()} onclick={saveKey}>
      {i18n.optional("chat.saveKey", "Save key")}
    </button>
    {#if chat.error}<p class="err">{chat.error}</p>{/if}
  </div>
{:else if active}
  <div class="chat-pane">
    <header class="chat-head">
      <button class="ghost icon" onclick={() => (chat.activeSlug = null)} title={i18n.optional("chat.back", "Back")}>
        <ArrowLeft size={18} />
      </button>
      <div class="chat-title">
        <strong>{active.agentName}</strong>
        <select
          aria-label={i18n.optional("chat.model", "Model")}
          value={active.model ?? chat.key.model ?? ""}
          onchange={(e) => {
            active.model = (e.currentTarget as HTMLSelectElement).value || null;
          }}
        >
          {#if chat.models.length === 0}
            <option value="">default model</option>
          {/if}
          {#each chat.models as m (m.id)}
            <option value={m.id}>{m.name}</option>
          {/each}
        </select>
      </div>
      <button
        class="ghost icon"
        class:attached={!!active.projectPath}
        onclick={() => (projectPicker = true)}
        title={active.projectPath ?? i18n.optional("chat.attachProject", "Attach project")}
      >
        <FolderGit2 size={16} />
      </button>
      {#if active.projectPath}
        <button
          class="ghost icon"
          class:attached={(active.attachedFiles ?? []).length > 0}
          onclick={() => {
            filePicker = true;
            void loadTree(active.projectPath!);
          }}
          title={i18n.optional("chat.attachFiles", "Attach files")}
        >
          <Paperclip size={16} />
        </button>
      {/if}
      <button
        class="ghost icon"
        onclick={() => chat.close(active.slug)}
        title={i18n.optional("chat.clear", "Clear conversation")}
      >
        <Trash2 size={16} />
      </button>
    </header>

    <div class="chat-log">
      {#if active.projectPath && active.messages.length === 0}
        <p class="ws-note">
          📁 {active.projectLabel}
          {#if (active.attachedFiles ?? []).length}
            · {(active.attachedFiles ?? []).length} {i18n.optional("chat.filesAttached", "files attached")}
          {/if}
        </p>
      {/if}
      {#each active.messages as m, i (i)}
        <div class="msg" class:me={m.role === "user"}>
          <div class="bubble">{m.content || (chat.streaming && i === active.messages.length - 1 ? "…" : "")}</div>
          {#if m.role === "assistant" && !chat.streaming}
            {#each messageBlocks(i, m.content) as b (i + b.path)}
              <div class="file-card" class:done={isApplied(i, b.path)}>
                <FileDiff size={14} />
                <span class="fc-path" title={b.path}>{b.path}</span>
                <span class="fc-meta">{b.lines} {i18n.optional("chat.lines", "lines")}</span>
                {#if isApplied(i, b.path)}
                  <span class="fc-applied"><Check size={13} />{i18n.optional("chat.appliedTag", "applied")}</span>
                {:else}
                  <button class="fc-apply" onclick={() => openDiff(b, i)}>
                    {i18n.optional("chat.apply", "Apply")}
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
          {#if m.role === "assistant" && m.costUsd}
            <span class="cost">{fmtCost(m.costUsd)}</span>
          {/if}
        </div>
      {/each}
    </div>

    {#if chat.error}<p class="err">{chat.error}</p>{/if}

    <footer class="chat-input">
      <textarea
        rows="1"
        placeholder={i18n.optional("chat.placeholder", `Message ${active.agentName}…`)}
        bind:value={draft}
        onkeydown={onKeydown}
        disabled={chat.streaming}
      ></textarea>
      <button class="primary icon" disabled={!draft.trim() || chat.streaming} onclick={submit} title={i18n.optional("chat.send", "Send")}>
        <Send size={16} />
      </button>
    </footer>
    <p class="usage">
      {i18n.optional("chat.usageTotal", "Chat spend")}: {fmtCost(chat.usage.costUsd) || "$0"} ·
      {chat.usage.requests} {i18n.optional("chat.requests", "replies")}
    </p>
  </div>
{:else}
  <div class="chat-list">
    <header class="chat-list-head">
      <h2>{i18n.optional("chat.title", "Agent chat")}</h2>
      <span class="usage">
        {fmtCost(chat.usage.costUsd) || "$0"} · {chat.usage.requests}
        {i18n.optional("chat.requests", "replies")}
      </span>
    </header>
    {#if convs.length === 0}
      <div class="chat-empty">
        <MessageSquare size={28} />
        <p>{i18n.optional("chat.empty", "Open an agent in the Agents view and tap Chat.")}</p>
        <button class="ghost" onclick={() => ui.setSection("personas")}>
          {i18n.optional("chat.browseAgents", "Browse agents")}
        </button>
      </div>
    {:else}
      <ul class="convs">
        {#each convs as c (c.slug)}
          <li>
            <button class="conv" onclick={() => (chat.activeSlug = c.slug)}>
              <span class="conv-name">{c.agentName}</span>
              <span class="conv-meta">
                {c.messages.length}
                {i18n.optional("chat.messages", "messages")} · {new Date(c.updatedAt).toLocaleString()}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#if projectPicker}
  <div class="ws-modal" role="dialog" aria-modal="true">
    <div class="ws-modal-card">
      <h3>{i18n.optional("chat.attachProject", "Attach project")}</h3>
      {#if active?.projectPath}
        <button class="ws-row detach" onclick={() => { chat.attachProject(active.slug, null, null); projectPicker = false; }}>
          {i18n.optional("chat.detachProject", "Detach current project")}
        </button>
      {/if}
      {#if projects.list.length === 0}
        <p class="ws-hint">{i18n.optional("chat.noProjects", "No projects yet — add one in the Projects view first.")}</p>
      {:else}
        <div class="ws-list">
          {#each projects.list as p (p.path)}
            <button class="ws-row" class:sel={p.path === active?.projectPath} onclick={() => pickProject(p.path, p.label)}>
              <span class="ws-name">{p.label}</span>
              <span class="ws-path">{p.path}</span>
            </button>
          {/each}
        </div>
      {/if}
      <button class="ghost ws-close" onclick={() => (projectPicker = false)}>{i18n.t("common.close")}</button>
    </div>
  </div>
{/if}

{#if filePicker}
  <div class="ws-modal" role="dialog" aria-modal="true">
    <div class="ws-modal-card wide">
      <h3>{i18n.optional("chat.attachFiles", "Attach files")}</h3>
      <p class="ws-hint">
        {i18n.optional(
          "chat.attachHint",
          "Key files (README, package.json…) are attached automatically. Pick more files for the agent to read — max 8.",
        )}
      </p>
      {#if treeLoading}
        <p class="ws-hint">…</p>
      {:else}
        <div class="ws-list files">
          {#each treeEntries.filter((e) => !e.d) as e (e.p)}
            <button class="ws-row file" class:sel={(active?.attachedFiles ?? []).includes(e.p)} onclick={() => toggleAttach(e.p)}>
              <span class="ws-name">{e.p}</span>
              {#if (active?.attachedFiles ?? []).includes(e.p)}<Check size={14} />{/if}
            </button>
          {/each}
        </div>
      {/if}
      <button class="ghost ws-close" onclick={() => (filePicker = false)}>
        {i18n.t("common.close")} {#if (active?.attachedFiles ?? []).length}· {(active?.attachedFiles ?? []).length}{/if}
      </button>
    </div>
  </div>
{/if}

{#if diffFor}
  <div class="ws-modal" role="dialog" aria-modal="true">
    <div class="ws-modal-card wide">
      <h3>{i18n.optional("chat.applyFile", `Apply ${diffFor.block.path}`)}</h3>
      <p class="ws-hint">
        {#if diffBusy}
          {i18n.optional("chat.diffing", "Computing diff…")}
        {:else if diffData}
          {diffData.exists ? diffData.summary : i18n.optional("chat.newFile", "New file — will be created.")}
        {/if}
      </p>
      <pre class="ws-diff">{diffData?.diff || ""}</pre>
      <div class="ws-actions">
        <button class="ghost" onclick={() => (diffFor = null)}>{i18n.t("common.cancel")}</button>
        <button
          class="primary"
          disabled={diffBusy || applyBusy || diffData?.identical}
          onclick={applyFile}
        >
          {applyBusy
            ? i18n.optional("chat.applying", "Applying…")
            : diffData?.identical
              ? i18n.optional("chat.identical", "Identical — nothing to apply")
              : i18n.optional("chat.applyFileBtn", "Apply to project")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .chat-setup,
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    max-width: 420px;
    margin: var(--space-8) auto;
    padding: var(--space-4);
    text-align: center;
    color: var(--color-text-secondary);
  }
  .chat-setup input {
    width: 100%;
  }
  h2 {
    font-size: var(--text-h1);
    font-weight: var(--fw-semibold);
    color: var(--color-text-primary);
  }
  .chat-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .chat-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }
  .chat-title {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .chat-title select {
    font-size: var(--text-small);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 2px 4px;
    max-width: 220px;
  }
  .chat-log {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) 0;
    min-height: 0;
  }
  .msg {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 88%;
  }
  .msg.me {
    align-self: flex-end;
    align-items: flex-end;
  }
  .bubble {
    padding: 8px 12px;
    border-radius: 14px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary, var(--color-bg));
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--text-body);
    line-height: 1.45;
  }
  .msg.me .bubble {
    background: var(--color-primary, #4f46e5);
    color: #fff;
    border-color: transparent;
  }
  .cost {
    font-size: 10px;
    color: var(--color-text-muted);
    margin-top: 2px;
  }
  .chat-input {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }
  .chat-input textarea {
    flex: 1;
    resize: none;
    max-height: 120px;
  }
  .usage {
    font-size: var(--text-small);
    color: var(--color-text-muted);
  }
  .chat-list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .convs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .conv {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-bg);
    cursor: pointer;
  }
  .conv:hover {
    border-color: var(--color-primary, #4f46e5);
  }
  .conv-name {
    font-weight: var(--fw-semibold);
    color: var(--color-text-primary);
  }
  .conv-meta {
    font-size: var(--text-small);
    color: var(--color-text-muted);
  }
  .err {
    color: var(--color-warning, #dc2626);
    font-size: var(--text-small);
    margin: 0;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  button.ghost {
    background: transparent;
  }

  /* ── Workspace context: project attach, apply cards, modals ── */
  .chat-head .icon.attached {
    color: var(--color-brand);
  }
  .ws-note {
    text-align: center; font-size: var(--text-caption); color: var(--color-text-muted);
    margin: var(--space-2) 0;
  }
  .file-card {
    display: flex; align-items: center; gap: 8px;
    margin-top: var(--space-2); padding: 6px 10px;
    border: 1px solid var(--color-border); border-radius: var(--radius-md);
    background: var(--color-surface-sunken); font-size: var(--text-caption);
  }
  .file-card.done { border-color: color-mix(in srgb, #22c55e 40%, var(--color-border)); }
  .fc-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
             font-family: var(--font-mono, monospace); font-weight: 600; }
  .fc-meta { color: var(--color-text-muted); white-space: nowrap; }
  .fc-applied { display: inline-flex; align-items: center; gap: 3px; color: #22c55e; font-weight: 600; }
  .fc-apply {
    flex: none; padding: 3px 12px; border-radius: 999px; border: none; cursor: pointer;
    background: var(--color-brand); color: #fff; font-size: var(--text-caption); font-weight: 600;
  }
  .fc-apply:hover { filter: brightness(1.1); }

  .ws-modal {
    position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
    background: rgb(0 0 0 / 0.5); padding: var(--space-4);
  }
  .ws-modal-card {
    display: flex; flex-direction: column; gap: var(--space-3);
    width: min(420px, 100%); max-height: 80vh; padding: var(--space-4);
    background: var(--color-surface-raised); border: 1px solid var(--color-border);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-lg, 0 10px 40px rgb(0 0 0 / 0.4));
  }
  .ws-modal-card.wide { width: min(640px, 100%); }
  .ws-modal-card h3 { margin: 0; font-size: var(--text-h2); }
  .ws-hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-body-sm); line-height: 1.5; }
  .ws-list { flex: 1; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .ws-row {
    display: flex; align-items: center; gap: 8px; text-align: left;
    padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid transparent;
    background: transparent; cursor: pointer; color: var(--color-text-primary);
  }
  .ws-row:hover { background: var(--color-surface-sunken); }
  .ws-row.sel { border-color: var(--color-brand); }
  .ws-row.detach { color: var(--color-danger, #ef4444); }
  .ws-row .ws-name { font-weight: 600; font-size: var(--text-body-sm); white-space: nowrap; }
  .ws-row .ws-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                     color: var(--color-text-muted); font-size: var(--text-caption); }
  .ws-row.file .ws-name { font-family: var(--font-mono, monospace); font-weight: 400; }
  .ws-close { align-self: flex-end; }
  .ws-diff {
    flex: 1; min-height: 160px; max-height: 46vh; overflow: auto; margin: 0;
    background: var(--color-surface-sunken); border-radius: var(--radius-md);
    padding: var(--space-3); font-size: var(--text-caption); line-height: 1.55;
    white-space: pre; font-family: var(--font-mono, monospace);
  }
  .ws-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>

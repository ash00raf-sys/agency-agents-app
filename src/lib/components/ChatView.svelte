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
  import Send from "@lucide/svelte/icons/send";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import MessageSquare from "@lucide/svelte/icons/message-square";

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

  async function submit() {
    const conv = active;
    const text = draft.trim();
    if (!conv || !text || chat.streaming) return;
    draft = "";
    try {
      const system = await systemFor(conv.slug);
      await chat.send(conv.slug, system, text, conv.model ?? chat.key.model);
    } catch {
      /* chat.error carries the message */
    }
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
        onclick={() => chat.close(active.slug)}
        title={i18n.optional("chat.clear", "Clear conversation")}
      >
        <Trash2 size={16} />
      </button>
    </header>

    <div class="chat-log">
      {#each active.messages as m, i (i)}
        <div class="msg" class:me={m.role === "user"}>
          <div class="bubble">{m.content || (chat.streaming && i === active.messages.length - 1 ? "…" : "")}</div>
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
</style>

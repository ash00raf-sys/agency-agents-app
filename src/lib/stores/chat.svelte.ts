/**
 * Agent chat store — conversations with any catalog agent via OpenRouter.
 *
 * Web build only: the backend (`web/lib/chat.mjs` + `POST /api/chat`) holds
 * the key and streams SSE; this store drives the UI, keeps conversations in
 * localStorage, and surfaces key/model/usage state. Native build: inert.
 */

import { invoke } from "@tauri-apps/api/core";
import { isWeb } from "$lib/util/platform";
import { errorText } from "$lib/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at?: string;
  costUsd?: number;
}

export interface Conversation {
  slug: string;
  agentName: string;
  model: string | null;
  messages: ChatMessage[];
  updatedAt: string;
}

interface ChatKeyStatus {
  configured: boolean;
  masked: string | null;
  model: string | null;
}

interface ChatUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  lastAt: string | null;
}

const STORE_KEY = "agency-agents:chats";

function loadConversations(): Conversation[] {
  if (!isWeb) return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveConversations(list: Conversation[]) {
  if (!isWeb) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 60)));
  } catch {
    /* storage full/blocked — chats stay in memory */
  }
}

class ChatStore {
  key: ChatKeyStatus = $state({ configured: false, masked: null, model: null });
  usage: ChatUsage = $state({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, lastAt: null });
  models: { id: string; name: string }[] = $state([]);
  modelsSource: "live" | "cache" | "fallback" | "" = $state("");
  conversations: Conversation[] = $state(loadConversations());
  /** The conversation currently open (by agent slug). */
  activeSlug: string | null = $state(null);
  streaming: boolean = $state(false);
  error: string | null = $state(null);

  get active(): Conversation | null {
    return this.conversations.find((c) => c.slug === this.activeSlug) ?? null;
  }

  /** Load key status + usage (+ models lazily). Safe to call on mount. */
  async load(): Promise<void> {
    if (!isWeb) return;
    try {
      this.key = await invoke<ChatKeyStatus>("chat_key_get");
    } catch {
      /* native / offline */
    }
    try {
      this.usage = await invoke<ChatUsage>("chat_usage");
    } catch {
      /* ignore */
    }
  }

  async loadModels(): Promise<void> {
    if (!isWeb || this.models.length > 0) return;
    try {
      const res = await invoke<{ source: string; models: { id: string; name: string }[] }>("chat_models");
      this.models = res.models;
      this.modelsSource = (res.source as typeof this.modelsSource) ?? "fallback";
    } catch {
      this.modelsSource = "fallback";
    }
  }

  async saveKey(key: string, model: string | null = null): Promise<void> {
    this.error = null;
    try {
      this.key = await invoke<ChatKeyStatus>("chat_key_set", { key, model });
      await this.loadModels();
    } catch (e) {
      this.error = errorText(e);
      throw e;
    }
  }

  async setModel(model: string): Promise<void> {
    try {
      this.key = await invoke<ChatKeyStatus>("chat_model_set", { model });
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** Open (or create) the conversation for an agent. */
  open(slug: string, agentName: string, model: string | null = null): void {
    this.activeSlug = slug;
    if (!this.conversations.some((c) => c.slug === slug)) {
      this.conversations.unshift({
        slug,
        agentName,
        model: model ?? this.key.model,
        messages: [],
        updatedAt: new Date().toISOString(),
      });
      saveConversations(this.conversations);
    }
  }

  close(slug: string): void {
    this.conversations = this.conversations.filter((c) => c.slug !== slug);
    if (this.activeSlug === slug) this.activeSlug = null;
    saveConversations(this.conversations);
  }

  /**
   * Send a user message and stream the assistant reply. `system` is the
   * agent's rendered markdown. Updates the conversation in place.
   */
  async send(slug: string, system: string, text: string, model: string | null): Promise<void> {
    const conv = this.conversations.find((c) => c.slug === slug);
    if (!conv || this.streaming) return;
    this.streaming = true;
    this.error = null;
    conv.messages.push({ role: "user", content: text, at: new Date().toISOString() });
    const assistant: ChatMessage = { role: "assistant", content: "", at: new Date().toISOString() };
    conv.messages.push(assistant);
    conv.updatedAt = new Date().toISOString();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model ?? conv.model ?? this.key.model,
          system,
          messages: conv.messages
            .filter((m) => m.content !== "")
            .slice(0, -1)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail.slice(0, 200) || `chat failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 2);
          if (!frame.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(frame.slice(5).trim());
            if (evt.type === "delta" && typeof evt.text === "string") {
              assistant.content += evt.text;
            } else if (evt.type === "done") {
              assistant.costUsd = evt.usage?.costUsd ?? 0;
              conv.model = evt.model ?? conv.model;
              this.usage = await invoke<ChatUsage>("chat_usage").catch(() => this.usage);
            } else if (evt.type === "error") {
              throw new Error(evt.message ?? "stream error");
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes("stream error")) throw e;
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      if (assistant.content === "") throw new Error("empty response from model");
      saveConversations(this.conversations);
    } catch (e) {
      this.error = errorText(e) || String(e);
      // Drop the empty assistant bubble so the retry is clean.
      if (assistant.content === "") conv.messages = conv.messages.filter((m) => m !== assistant);
      throw e;
    } finally {
      this.streaming = false;
      saveConversations(this.conversations);
    }
  }
}

export const chat = new ChatStore();

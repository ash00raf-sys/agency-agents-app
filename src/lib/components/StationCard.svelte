<script lang="ts">
  /**
   * StationCard — live, read-only view of the DevForge station daemon
   * (web build). The stationd API runs on the same device (127.0.0.1:8090
   * by default); this card surfaces health, model/tier/context pressure,
   * key balance and recent coach events. Fail-soft: a stopped daemon shows
   * a quiet "not detected" state.
   */
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { isWeb } from "$lib/util/platform";
  import { i18n } from "$lib/stores/i18n.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  interface StationStatus {
    available: boolean;
    url: string;
    health: { status?: string; version?: string; uptime_s?: number } | null;
    status: {
      model?: string;
      tier?: string;
      ctx_pct?: number;
      balance?: number | string;
      auto?: boolean;
    } | null;
    usage: { balance?: number | string } | null;
  }

  let st: StationStatus | null = $state(null);
  let loading = $state(false);

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      st = await invoke<StationStatus>("station_status");
    } catch {
      st = null;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (isWeb) void refresh();
  });

  function balanceOf(): string | null {
    const b = st?.usage?.balance ?? st?.status?.balance;
    if (b === null || b === undefined || b === "") return null;
    const n = Number(b);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(b);
  }

  function fmtUptime(s: number | undefined): string | null {
    if (!s || s < 0) return null;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
</script>

{#if isWeb}
  <div class="card station">
    <h3 class="c-title">{i18n.optional("station.title", "DevForge Station")}</h3>
    <div class="card-fill">
      {#if !st}
        <p class="muted">{i18n.optional("station.checking", "Checking…")}</p>
      {:else if !st.available}
        <p class="muted">
          {i18n.optional("station.notDetected", "Station daemon not detected")}
          <span class="mono">({st.url})</span>
        </p>
      {:else}
        <ul class="facts">
          <li>
            <span class="k">{i18n.optional("station.daemon", "Daemon")}</span>
            <span class="v ok">
              {i18n.optional("station.up", "up")}
              {#if st.health?.version}<span class="mono">v{st.health.version}</span>{/if}
              {#if st.health && fmtUptime(st.health.uptime_s)}· {fmtUptime(st.health.uptime_s)}{/if}
            </span>
          </li>
          {#if st.status?.model}
            <li>
              <span class="k">{i18n.optional("station.model", "Model")}</span>
              <span class="v mono">{st.status.model}</span>
            </li>
          {/if}
          {#if st.status?.tier}
            <li>
              <span class="k">{i18n.optional("station.tier", "Tier")}</span>
              <span class="v">{st.status.tier}</span>
            </li>
          {/if}
          {#if typeof st.status?.ctx_pct === "number"}
            <li>
              <span class="k">{i18n.optional("station.context", "Context")}</span>
              <span class="v">{Math.round(st.status.ctx_pct)}%</span>
            </li>
          {/if}
          {#if balanceOf()}
            <li>
              <span class="k">{i18n.optional("station.balance", "Key balance")}</span>
              <span class="v">{balanceOf()}</span>
            </li>
          {/if}
        </ul>
        <div class="row-actions">
          <a class="link" href={st.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={12} />
            {i18n.optional("station.open", "Open Station")}
          </a>
        </div>
      {/if}
      <button class="link inline" disabled={loading} onclick={refresh}>
        <span class="spin-wrap" class:spin={loading}><RefreshCw size={12} /></span>
        {i18n.optional("station.refresh", "Refresh")}
      </button>
    </div>
  </div>
{/if}

<style>
  .station .card-fill {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  .facts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  }
  .facts li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: var(--text-small);
  }
  .k { color: var(--color-text-muted); }
  .v { color: var(--color-text-primary); font-weight: var(--fw-semibold); text-align: right; overflow-wrap: anywhere; }
  .v.ok { color: var(--color-success, #059669); }
  .mono { font-family: var(--font-mono, monospace); font-size: 0.95em; }
  .row-actions { display: flex; gap: 12px; align-items: center; }
  .spin-wrap { display: inline-flex; }
  .spin-wrap.spin { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>

<script lang="ts">
  /**
   * Projects — the 4th pillar (Agents / Tools / Teams / Projects). The home for
   * per-project deployments: every folder you've installed agents into.
   *
   * Master/detail (not inline disclosures — a big roster gets unruly):
   *  • List: a row per project (folder · label · path · count). Clicking a row
   *    navigates into its detail via `ui.selectProject(path)` — a nav location,
   *    so the title-bar Back button returns to the list.
   *  • Detail: that project's path, actions (Deploy… · Reveal · Remove from
   *    list), and its roster grouped by division (collapsible), reusing the
   *    division-group pattern from Tools/Teams.
   *
   * "Deploy…" opens the two-pane DeployBrowser scoped to the project (pick an
   * agent, division, or team on the left; install into the project's tools on
   * the right) — so an empty project can be filled.
   */
  import { errorText } from "$lib/types";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { isWeb } from "$lib/util/platform";
  import EmptyState from "./EmptyState.svelte";
  import Pill from "./Pill.svelte";
  import Button from "./Button.svelte";
  import Modal from "./Modal.svelte";
  import DeployBrowser from "./DeployBrowser.svelte";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Globe from "@lucide/svelte/icons/globe";
  import Hammer from "@lucide/svelte/icons/hammer";

  import { install } from "$lib/stores/install.svelte";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { projects } from "$lib/stores/projects.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import { resolveCategoryIcon } from "$lib/util/categoryIcon";
  import { i18n } from "$lib/stores/i18n.svelte";
  import type { InstalledAgent } from "$lib/types";

  // ── DevForge session workspaces (web build): the ~/DevForge/<name> dirs
  //    station creates. Read-only scan surfaced as one-tap quick-adds. ──
  let devforge: { name: string; path: string; git: boolean; aider: boolean }[] = $state([]);

  async function loadDevforge() {
    if (!isWeb) return;
    try {
      const res = await invoke<{ workspaces: typeof devforge }>("web_devforge_workspaces");
      // "Already known" = a registered root or a path with installed rows.
      const known = new Set<string>([
        ...projects.list.map((p) => p.path),
      ]);
      devforge = res.workspaces.filter((w) => !known.has(w.path));
    } catch {
      devforge = [];
    }
  }

  onMount(() => {
    corpus.ensureLoaded();
    projects.refresh();
    void loadDevforge();
  });

  // ── Per-project roster: rows we (or anyone) deployed into that exact path. ──
  // Keyed by the project's absolute path; null projectPath = global, excluded.
  const rowsByProject = $derived.by(() => {
    const m = new Map<string, InstalledAgent[]>();
    for (const r of install.installed) {
      if (r.state === "removed") continue; // ledger says installed but file gone
      const p = r.projectPath;
      if (p == null) continue; // global scope lives in Teams/Tools, not here
      const arr = m.get(p);
      if (arr) arr.push(r);
      else m.set(p, [r]);
    }
    return m;
  });

  function rosterFor(path: string): InstalledAgent[] {
    return rowsByProject.get(path) ?? [];
  }

  // ── Selected project (detail pane). Resolve against the live list so a stale
  //    path (e.g. removed) falls back to the list rather than an empty detail. ──
  const selected = $derived(projects.list.find((p) => p.path === ui.projectsSelected) ?? null);

  // ── Group the selected project's roster by division (collapsible). ──
  const OTHER = "__other";
  const detailGroups = $derived.by(() => {
    if (!selected) return [];
    const divOf = new Map(corpus.agents.map((a) => [a.slug, a.category]));
    const m = new Map<string, InstalledAgent[]>();
    for (const r of rosterFor(selected.path)) {
      const div = divOf.get(r.slug) ?? OTHER;
      const arr = m.get(div);
      if (arr) arr.push(r);
      else m.set(div, [r]);
    }
    const out = [...m.entries()].map(([slug, rows]) => ({
      slug,
      label: slug === OTHER ? i18n.t("common.other") : corpus.labelOf(slug),
      color: slug === OTHER ? "#94A3B8" : corpus.colorOf(slug),
      icon: slug === OTHER ? "HelpCircle" : corpus.iconOf(slug),
      rows: rows.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }));
    out.sort((a, b) => (a.slug === OTHER ? 1 : b.slug === OTHER ? -1 : a.label.localeCompare(b.label)));
    return out;
  });

  // Division groups are CLOSED by default; initialize the collapse set to every
  // division once per project (guarded so installs/removes don't re-collapse).
  let collapsed = $state<Set<string>>(new Set());
  function toggleGroup(slug: string) {
    const next = new Set(collapsed);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    collapsed = next;
  }
  let collapseInitFor: string | null = null;
  $effect(() => {
    const p = ui.projectsSelected;
    // Wait for the roster to populate before seeding (cold corpus load) so the
    // divisions stay closed by default rather than seeding from an empty list.
    if (p === collapseInitFor || detailGroups.length === 0) return;
    collapseInitFor = p;
    collapsed = new Set(detailGroups.map((g) => g.slug));
  });

  // ── Deploy into a project: the two-pane DeployBrowser. ──
  let browseFor = $state<string | null>(null); // project path, or null = closed

  // ── Web preview + builder (web build): detect the selected project's type,
  //    expose its live /p/<name>/ URL, and run web builds from the app. ──
  type PreviewInfo = {
    kind: string;
    label: string;
    previewable: boolean;
    buildable: boolean;
    buildCmd: string | null;
    hint: string | null;
    name: string;
    previewUrl: string;
    path: string;
  };
  type BuildResult = { ran: boolean; ok: boolean; log: string; durationMs?: number };
  let pv = $state<PreviewInfo | null>(null);
  let buildFor = $state<PreviewInfo | null>(null); // open modal
  let building = $state(false);
  let buildResult = $state<BuildResult | null>(null);

  $effect(() => {
    const p = ui.projectsSelected;
    pv = null;
    if (!isWeb || !p) return;
    invoke<PreviewInfo>("preview_detect", { path: p })
      .then((r) => {
        if (ui.projectsSelected === p) pv = r;
      })
      .catch(() => (pv = null));
  });

  function openBuild(info: PreviewInfo) {
    buildResult = null;
    building = false;
    buildFor = info;
  }

  async function runWebBuild() {
    if (!buildFor || building) return;
    building = true;
    buildResult = null;
    try {
      buildResult = await invoke<BuildResult>("preview_build", { path: buildFor.path });
    } catch (e) {
      buildResult = { ran: false, ok: false, log: errorText(e) };
    } finally {
      building = false;
    }
  }

  async function reveal(path: string) {
    try {
      await install.revealPath(path);
    } catch (e) {
      toast.error(i18n.t("common.couldNotOpenFolder"), errorText(e));
    }
  }

  // ── Remove a project: a confirm dialog with two choices (#44). ──
  // Snapshot label/count at open time so they stay stable across the async op
  // (reconcile mutates projects.list mid-flight).
  let confirm = $state<{ path: string; label: string; count: number } | null>(null);
  let deleteBusy = $state(false);

  function finishRemove(path: string) {
    confirm = null;
    if (ui.projectsSelected === path) ui.selectProject(null);
  }

  // "Remove from app only" — forget the project; installed files stay on disk.
  async function forgetProject() {
    if (!confirm || deleteBusy) return;
    const { path, label } = confirm;
    deleteBusy = true;
    try {
      await install.forgetProject(path, label);
      projects.unregister(path);
      finishRemove(path);
    } catch (e) {
      toast.error(i18n.t("common.actionFailed"), errorText(e));
    } finally {
      deleteBusy = false;
    }
  }

  // "Remove & uninstall" — delete the agents THIS APP installed here (never the
  // user's own files; uninstall backs up modified files first), then forget.
  async function uninstallAndRemove() {
    if (!confirm || deleteBusy) return;
    const { path } = confirm;
    deleteBusy = true;
    try {
      const targets = rosterFor(path).map((r) => ({ slug: r.slug, tool: r.tool, projectPath: path }));
      if (targets.length > 0) await install.bulk("uninstall", targets);
      projects.unregister(path);
      finishRemove(path);
    } catch (e) {
      toast.error(i18n.t("common.actionFailed"), errorText(e));
    } finally {
      deleteBusy = false;
    }
  }

  let adding = $state(false);
  async function addProject() {
    if (adding) return;
    adding = true;
    try {
      const p = await projects.addViaPicker();
      if (!p) return;
      await projects.refresh();
      ui.selectProject(p); // land in the new project's detail (Deploy… from there)
    } finally {
      adding = false;
    }
  }
</script>

<section class="pr">
  {#if selected}
    <!-- ── Detail ── -->
    <header class="pr-head detail">
      <span class="dh-ic"><FolderIcon size={20} /></span>
      <div class="dh-id">
        <h2 class="dh-label">{selected.label}</h2>
        <button class="dh-path" title={selected.path} onclick={() => reveal(selected.path)}>{selected.path}</button>
      </div>
      <span class="dh-count">{i18n.count(selected.installedCount, "common.agent.one", "common.agent.many")}</span>
      {#if pv}
        <span class="kind-pill" title={pv.hint ?? pv.label}>{pv.label}</span>
      {/if}
      {#if pv?.previewable}
        <button class="btn" onclick={() => pv && window.open(pv.previewUrl, "_blank")} title={pv.previewUrl}>
          <Globe size={15} /><span>{i18n.optional("projects.openPreview", "Open preview")}</span>
        </button>
      {/if}
      {#if pv?.buildable}
        <button class="btn" onclick={() => pv && openBuild(pv)}>
          <Hammer size={15} /><span>{i18n.optional("projects.buildWeb", "Build web app")}</span>
        </button>
      {/if}
      <button class="btn" onclick={() => reveal(selected.path)}><FolderOpen size={15} /><span>{i18n.t("common.reveal")}</span></button>
      <button class="btn primary" onclick={() => (browseFor = selected.path)}>{i18n.t("teams.deploy")}</button>
      <button class="btn danger-ic" title={i18n.t("projects.removeTitle")} aria-label={i18n.t("projects.removeAria")} onclick={() => (confirm = { path: selected.path, label: selected.label, count: selected.installedCount })}><Trash2 size={15} /></button>
    </header>

    <div class="scroll">
      {#if detailGroups.length === 0}
        <div class="d-empty">
          <LayersIcon size={40} />
          <p>{i18n.t("projects.emptyHere")}</p>
          <Button variant="primary" onclick={() => (browseFor = selected.path)}>{i18n.t("projects.deployDivisionTeam")}</Button>
        </div>
      {:else}
        <div class="groups">
          {#each detailGroups as g (g.slug)}
            {@const Icon = resolveCategoryIcon(g.icon)}
            {@const isOpen = !collapsed.has(g.slug)}
            <section class="grp">
              <button class="grp-head" onclick={() => toggleGroup(g.slug)} aria-expanded={isOpen}>
                <ChevronDown size={15} class={isOpen ? "pr-chev open" : "pr-chev"} />
                <span class="grp-ic" style="color:{g.color}"><Icon size={15} /></span>
                <span class="grp-label">{g.label}</span>
                <span class="grp-count">{g.rows.length}</span>
              </button>
              {#if isOpen}
                <ul class="roster">
                  {#each g.rows as r (r.slug + r.tool)}
                    <li class="r-row">
                      <span class="r-name">{r.name}</span>
                      <Pill tone="neutral">{install.toolLabel(r.tool)}</Pill>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- ── List ── -->
    <header class="pr-head">
      <p class="pr-count">{i18n.t("projects.count", { count: projects.list.length })}</p>
      <div class="pr-actions">
        {#if isWeb && devforge.length > 0}
          <div class="df-quick">
            <span class="df-lbl">{i18n.optional("projects.devforgeWorkspaces", "DevForge workspaces")}</span>
            {#each devforge as w (w.path)}
              <button
                class="df-chip"
                onclick={() => {
                  projects.register(w.path);
                  devforge = devforge.filter((x) => x.path !== w.path);
                  ui.selectProject(w.path);
                }}
                title={w.path}
              >{w.name}</button>
            {/each}
          </div>
        {/if}
        <button class="btn primary" disabled={adding} onclick={addProject}>
          <FolderPlus size={15} /><span>{i18n.t("projects.add")}</span>
        </button>
      </div>
    </header>

    {#if projects.list.length === 0}
      <div class="scroll">
        <EmptyState title={i18n.t("projects.emptyTitle")}>
          {#snippet icon()}<FolderIcon size={48} />{/snippet}
          {i18n.t("projects.emptyBody")}
          {#snippet cta()}
            <div class="empty-cta">
              <Button variant="primary" disabled={adding} onclick={addProject}>
                {#snippet icon()}<FolderPlus size={15} />{/snippet}
                {i18n.t("projects.add")}
              </Button>
              <button class="link-btn" onclick={() => ui.openPlaybook()}>{i18n.t("projects.openPlaybook")}</button>
            </div>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <ul class="rows">
        {#each projects.list as project (project.path)}
          <li class="proj">
            <button class="proj-row" onclick={() => ui.selectProject(project.path)}>
              <span class="proj-ic"><FolderIcon size={18} /></span>
              <span class="proj-body">
                <span class="proj-label">{project.label}</span>
                <span class="proj-path" title={project.path}>{project.path}</span>
              </span>
              <span class="proj-count">{i18n.count(project.installedCount, "common.agent.one", "common.agent.many")}</span>
              <ChevronRight size={16} class="proj-go" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if browseFor !== null}
  <DeployBrowser projectPath={browseFor} onClose={() => (browseFor = null)} />
{/if}

{#if buildFor}
  <Modal
    open
    title={i18n.optional("projects.buildTitle", `Build ${buildFor.label}`)}
    onClose={() => (buildFor = null)}
  >
    <div class="build-body">
      <p class="build-path">{buildFor.path}</p>
      <p class="build-cmd"><code>{buildFor.buildCmd ?? "npm run build"}</code></p>
      <p class="build-note">
        {i18n.optional(
          "projects.buildWarning",
          "Runs on your phone with Termux access — only build projects you trust.",
        )}
      </p>
      {#if buildResult}
        <pre class="build-log" class:bad={!buildResult.ok}>{buildResult.log || "(no output)"}</pre>
        {#if buildResult.ok}
          <p class="build-ok">
            ✓ {i18n.optional("projects.buildDone", "Built")} ·
            {buildResult.durationMs != null ? `${(buildResult.durationMs / 1000).toFixed(1)}s · ` : ""}
            <a href={buildFor.previewUrl} target="_blank" rel="noreferrer">
              {i18n.optional("projects.openPreview", "Open preview")}
            </a>
          </p>
        {/if}
      {:else if building}
        <p class="build-wait">{i18n.optional("projects.building", "Building… (this can take a minute)")}</p>
      {/if}
    </div>
    {#snippet actions()}
      <Button variant="secondary" modalAction="cancel" onclick={() => (buildFor = null)}>
        {i18n.t("common.close")}
      </Button>
      {#if buildResult?.ok}
        <Button variant="primary" onclick={() => window.open(buildFor.previewUrl, "_blank")}>
          {i18n.optional("projects.openPreview", "Open preview")}
        </Button>
      {:else}
        <Button variant="primary" disabled={building} onclick={runWebBuild}>
          {building
            ? i18n.optional("projects.building", "Building…")
            : i18n.optional("projects.runBuild", "Run build")}
        </Button>
      {/if}
    {/snippet}
  </Modal>
{/if}

{#if confirm}
  <Modal open title={i18n.t("projects.deleteTitle", { project: confirm.label })} defaultFocus="cancel" onClose={() => (confirm = null)}>
    <p class="del-body">
      {#if (confirm?.count ?? 0) > 0}
        {i18n.t("projects.deleteBody", { project: confirm.label, count: confirm.count })}
      {:else}
        {i18n.t("projects.deleteEmptyBody", { project: confirm.label })}
      {/if}
    </p>
    {#if (confirm?.count ?? 0) > 0}
      <p class="del-note">{i18n.t("projects.deleteExplain")}</p>
    {/if}
    {#snippet actions()}
      <Button variant="secondary" modalAction="cancel" onclick={() => (confirm = null)}>{i18n.t("common.cancel")}</Button>
      {#if (confirm?.count ?? 0) > 0}
        <Button variant="danger" disabled={deleteBusy} onclick={uninstallAndRemove}>
          {i18n.t("projects.deleteUninstall", { count: confirm?.count ?? 0 })}
        </Button>
      {/if}
      <Button variant="primary" modalAction="confirm" disabled={deleteBusy} onclick={forgetProject}>{i18n.t("projects.deleteKeep")}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .df-quick { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
  .df-lbl { font-size: var(--text-small); color: var(--color-text-muted); }
  .df-chip {
    font-size: var(--text-small); font-weight: 600; padding: 3px 10px;
    border-radius: 999px; border: 1px solid var(--color-border);
    background: transparent; color: var(--color-text-secondary); cursor: pointer;
  }
  .df-chip:hover { border-color: var(--color-primary, #4f46e5); color: var(--color-primary, #4f46e5); }
  .pr { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .pr-head {
    flex: none; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border);
  }
  .pr-count { color: var(--color-text-secondary); font-size: var(--text-body-sm); }
  .pr-actions { display: flex; gap: var(--space-2); }

  /* ── Detail header ── */
  .pr-head.detail { justify-content: flex-start; }
  .dh-ic {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: var(--radius-md);
    background: var(--color-surface-sunken); color: var(--color-text-secondary);
  }
  .dh-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .dh-label { font-size: var(--text-h2); font-weight: var(--fw-semibold); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dh-path {
    font-size: var(--text-caption); color: var(--color-text-muted); background: transparent;
    text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
  }
  .dh-path:hover { color: var(--color-brand); text-decoration: underline; }
  .dh-count { flex: none; font-size: var(--text-body-sm); color: var(--color-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    height: 32px; padding: 0 var(--space-3);
    border: 1px solid var(--color-border); border-radius: var(--radius-md);
    background: transparent; color: var(--color-text-secondary);
    font-size: var(--text-body-sm); cursor: pointer; flex: none;
  }
  .btn:hover:not(:disabled) { color: var(--color-text-primary); background: var(--color-surface-sunken); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.primary { background: var(--color-brand); color: var(--color-text-inverse); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--color-brand); }
  .btn.danger-ic { padding: 0; width: 32px; justify-content: center; }
  .btn.danger-ic:hover { color: var(--color-danger); border-color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 10%, transparent); }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; }

  .empty-cta { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); }
  .link-btn { background: transparent; color: var(--color-text-link, var(--color-brand)); font-size: var(--text-body-sm); cursor: pointer; padding: 2px; }
  .link-btn:hover { text-decoration: underline; }

  /* ── Project list rows ── */
  .rows { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
  .proj { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-raised); overflow: hidden; }
  .proj:hover { border-color: var(--color-border-strong, var(--color-text-muted)); }
  .proj-row {
    width: 100%; display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-3); background: transparent; cursor: pointer; text-align: left;
  }
  .proj-row:hover { background: var(--color-surface-sunken); }
  .proj-ic { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--color-surface-sunken); color: var(--color-text-secondary); }
  .proj-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .proj-label { font-weight: var(--fw-semibold); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-path { font-size: var(--text-caption); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-count { flex: none; font-size: var(--text-body-sm); color: var(--color-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  :global(.proj-go) { flex: none; color: var(--color-text-muted); }

  /* ── Division groups (detail roster) ── */
  .groups { padding: var(--space-3); display: flex; flex-direction: column; gap: 2px; }
  .grp { display: flex; flex-direction: column; }
  .grp-head {
    display: flex; align-items: center; gap: var(--space-2);
    width: 100%; padding: var(--space-2); border-radius: var(--radius-sm);
    background: transparent; cursor: pointer; text-align: left;
  }
  .grp-head:hover { background: var(--color-surface-sunken); }
  :global(.pr-chev) { color: var(--color-text-muted); transition: transform var(--motion-duration-fast, 120ms) ease; transform: rotate(-90deg); flex: none; }
  :global(.pr-chev.open) { transform: rotate(0deg); }
  .grp-ic { flex: none; display: inline-flex; }
  .grp-label { flex: 1; min-width: 0; font-weight: var(--fw-semibold); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grp-count { flex: none; min-width: 20px; text-align: center; font-size: var(--text-caption); color: var(--color-text-muted); font-variant-numeric: tabular-nums; background: var(--color-surface-sunken); border-radius: var(--radius-full); padding: 1px 7px; }

  .roster { list-style: none; margin: 0; padding: 2px 0 var(--space-2) var(--space-4); display: flex; flex-direction: column; gap: 1px; }
  .r-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); }
  .r-row:hover { background: var(--color-surface-sunken); }
  .r-name { flex: 1; min-width: 0; font-weight: var(--fw-medium); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .d-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); padding: var(--space-6); }
  .d-empty p { font-size: var(--text-body-sm); }

  /* ── Remove-project confirm dialog ── */
  .del-body { color: var(--color-text-primary); font-size: var(--text-body); }
  .del-note { margin-top: var(--space-3); color: var(--color-text-muted); font-size: var(--text-body-sm); line-height: 1.5; }

  /* ── Project kind + web build modal ── */
  .kind-pill {
    flex: none; font-size: var(--text-caption); font-weight: var(--fw-semibold);
    padding: 2px 10px; border-radius: 999px; border: 1px solid var(--color-border);
    color: var(--color-text-secondary); white-space: nowrap; max-width: 140px;
    overflow: hidden; text-overflow: ellipsis;
  }
  .build-body { display: flex; flex-direction: column; gap: var(--space-3); }
  .build-path { margin: 0; color: var(--color-text-muted); font-size: var(--text-caption); word-break: break-all; }
  .build-cmd { margin: 0; }
  .build-cmd code {
    background: var(--color-surface-sunken); padding: 3px 10px; border-radius: var(--radius-sm);
    font-size: var(--text-body-sm);
  }
  .build-note { margin: 0; color: var(--color-text-muted); font-size: var(--text-body-sm); line-height: 1.5; }
  .build-log {
    margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    background: var(--color-surface-sunken); border-radius: var(--radius-md);
    padding: var(--space-3); font-size: var(--text-caption); line-height: 1.5;
  }
  .build-log.bad { color: var(--color-danger, #ef4444); }
  .build-wait { margin: 0; color: var(--color-text-muted); font-size: var(--text-body-sm); }
  .build-ok { margin: 0; color: var(--color-text-primary); font-size: var(--text-body-sm); }
  .build-ok a { color: var(--color-text-link, var(--color-brand)); }

</style>

import { t, uiAttribute, uiLabel, uiText, type Message } from "./i18n.js";
import { icon } from "./icons.js";
import { createSidebarPanel } from "./sidebar-panel.js";

type StyleStatus = "analyzed" | "draft" | "retired" | "verified";

type StyleEntry = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly latestVersion: string;
  readonly status: StyleStatus;
  readonly tags: readonly string[];
  readonly versionCount: number;
  readonly preview: string;
};

type StyleDetail = {
  readonly entry: StyleEntry;
  readonly metadata: {
    readonly version: string;
    readonly status: StyleStatus;
    readonly source: {
      readonly durationSec: number;
      readonly width: number;
      readonly height: number;
      readonly fps: number;
      readonly sha256: string;
    };
    readonly reference: {
      readonly asrEngine: string;
    };
  };
  readonly documents: {
    readonly analysis: string;
    readonly timeline: string;
  };
  readonly assets: {
    readonly preview: string;
    readonly evidence: readonly string[];
    readonly source: string;
    readonly transcript: string;
  };
};

type StyleSelection = {
  readonly format: "hypit.style-selection@1";
  readonly updatedAt: string | null;
  readonly styles: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly preview: string;
  }[];
};

export type StylesPane = {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
  activate(): void;
};

function statusLabel(status: StyleStatus): Message {
  if (status === "verified") return "library.style-status-verified";
  if (status === "analyzed") return "library.style-status-analyzed";
  if (status === "retired") return "library.style-status-retired";
  return "library.style-status-draft";
}

function excerpt(text: string, length: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= length ? normalized : `${normalized.slice(0, length).trimEnd()}...`;
}

export function createStylesPane(): StylesPane {
  const panel = createSidebarPanel("layers", "library.style-categories");
  panel.toolbar.innerHTML = `<span class="code-location" data-style-heading>${uiLabel("library.styles")}</span>
    <button type="button" class="library-refresh" data-style-refresh ${uiAttribute("aria-label", "library.refresh-styles")} ${uiAttribute("title", "common.refresh")}>${icon("refresh")}</button>`;
  panel.content.innerHTML = `<div class="media-status" data-style-status role="status" hidden></div><div class="style-detail" data-style-detail></div>`;
  const heading = panel.toolbar.querySelector<HTMLElement>("[data-style-heading]")!;
  const status = panel.content.querySelector<HTMLElement>("[data-style-status]")!;
  const detailNode = panel.content.querySelector<HTMLElement>("[data-style-detail]")!;
  let entries: readonly StyleEntry[] = [];
  let selected: string | undefined;
  let detail: StyleDetail | undefined;
  let loaded = false;
  let request = 0;
  const selectedStyleIds = new Set<string>();
  let selectionSaving = false;
  let selectionError: string | undefined;

  const showStatus = (message?: string): void => {
    status.hidden = message === undefined;
    status.textContent = message ?? "";
  };

  const renderDetail = (): void => {
    if (detail === undefined) {
      detailNode.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${icon("layers")}</span><strong></strong><p></p></div>`;
      uiText(detailNode.querySelector("strong")!, entries.length === 0 ? "library.no-styles" : "library.choose-style");
      uiText(detailNode.querySelector("p")!, entries.length === 0 ? "library.style-empty-hint" : "library.style-hint");
      return;
    }
    const facts = [
      ["library.style-version", `v${detail.metadata.version}`],
      ["library.style-duration", `${detail.metadata.source.durationSec.toFixed(2)} s`],
      ["library.style-canvas", `${detail.metadata.source.width} x ${detail.metadata.source.height}`],
      ["library.style-frame-rate", `${detail.metadata.source.fps} fps`],
      ["library.style-asr", detail.metadata.reference.asrEngine],
    ] as const;
    detailNode.innerHTML = `
      <article class="style-card-detail">
        <img class="style-cover" alt="">
        <div class="style-copy">
          <div class="style-title-row">
            <h3></h3>
            <span class="style-status"></span>
          </div>
          <p class="style-summary"></p>
          <div class="style-tags"></div>
          <div class="style-facts"></div>
        </div>
      </article>
      <details class="style-analysis" open>
        <summary>${uiLabel("library.style-analysis")}</summary>
        <p data-analysis></p>
      </details>
      <details class="style-analysis">
        <summary>${uiLabel("library.style-timeline")}</summary>
        <p data-timeline></p>
      </details>
      <section class="style-evidence">
        <h4>${uiLabel("library.style-evidence")}</h4>
        <div class="style-evidence-grid"></div>
      </section>
      <div class="style-links">
        <a data-source>${uiLabel("library.style-reference")}</a>
        <a data-transcript>${uiLabel("library.style-transcript")}</a>
      </div>`;
    const cover = detailNode.querySelector<HTMLImageElement>(".style-cover")!;
    cover.src = detail.assets.preview;
    cover.alt = detail.entry.name;
    detailNode.querySelector("h3")!.textContent = detail.entry.name;
    const statusNode = detailNode.querySelector<HTMLElement>(".style-status")!;
    uiText(statusNode, statusLabel(detail.metadata.status));
    statusNode.dataset.status = detail.metadata.status;
    detailNode.querySelector<HTMLElement>(".style-summary")!.textContent = detail.entry.summary;
    detailNode.querySelector<HTMLElement>(".style-tags")!.replaceChildren(...detail.entry.tags.map((tag) => {
      const item = document.createElement("span");
      item.textContent = tag;
      return item;
    }));
    detailNode.querySelector<HTMLElement>(".style-facts")!.replaceChildren(...facts.map(([label, value]) => {
      const row = document.createElement("div");
      row.innerHTML = "<span></span><strong></strong>";
      uiText(row.querySelector("span")!, label);
      row.querySelector("strong")!.textContent = value;
      return row;
    }));
    detailNode.querySelector<HTMLElement>("[data-analysis]")!.textContent = excerpt(detail.documents.analysis, 520);
    detailNode.querySelector<HTMLElement>("[data-timeline]")!.textContent = excerpt(detail.documents.timeline, 520);
    detailNode.querySelector<HTMLElement>(".style-evidence-grid")!.replaceChildren(...detail.assets.evidence.map((url, index) => {
      const image = document.createElement("img");
      image.src = url;
      image.alt = `${detail!.entry.name} ${index + 1}`;
      image.loading = "lazy";
      return image;
    }));
    detailNode.querySelector<HTMLAnchorElement>("[data-source]")!.href = detail.assets.source;
    detailNode.querySelector<HTMLAnchorElement>("[data-transcript]")!.href = detail.assets.transcript;
  };

  const select = async (id: string): Promise<void> => {
    selected = id;
    heading.textContent = entries.find((entry) => entry.id === id)?.name ?? uiLabel("library.styles");
    showStatus(t("library.style-loading-detail"));
    const current = ++request;
    try {
      const response = await fetch(`/__studio/style-library/detail?id=${encodeURIComponent(id)}`);
      const value = await response.json() as StyleDetail & { readonly error?: string };
      if (!response.ok || value.error !== undefined) throw new Error(value.error ?? "Style unavailable");
      if (current !== request) return;
      detail = value;
      showStatus();
      renderDetail();
    } catch (error) {
      if (current !== request) return;
      showStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const saveSelection = async (ids: ReadonlySet<string>): Promise<void> => {
    selectionSaving = true;
    selectionError = undefined;
    renderList();
    try {
      const response = await fetch("/__studio/style-library/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...ids] }),
      });
      const value = await response.json() as StyleSelection & { readonly error?: string };
      if (!response.ok || value.error !== undefined) throw new Error(value.error ?? "Style selection unavailable");
      selectedStyleIds.clear();
      for (const style of value.styles) selectedStyleIds.add(style.id);
    } catch (error) {
      selectionError = error instanceof Error ? error.message : String(error);
    } finally {
      selectionSaving = false;
      renderList();
    }
  };

  const renderList = (): void => {
    const summary = document.createElement("div");
    summary.className = "style-selection-summary";
    summary.innerHTML = `<div><strong></strong><span></span></div><button type="button" class="style-selection-clear"></button>`;
    uiText(summary.querySelector("strong")!, "library.style-selection-title");
    const selectionState = summary.querySelector("span")!;
    if (selectionSaving) uiText(selectionState, "library.style-selection-saving");
    else if (selectionError !== undefined) {
      selectionState.removeAttribute("data-ui-text");
      selectionState.textContent = selectionError;
    } else if (selectedStyleIds.size === 0) uiText(selectionState, "library.style-selection-none");
    else uiText(selectionState, "library.style-selection-count", { count: selectedStyleIds.size });
    const clear = summary.querySelector<HTMLButtonElement>(".style-selection-clear")!;
    uiText(clear, "library.style-selection-clear");
    clear.disabled = selectionSaving || selectedStyleIds.size === 0;
    clear.addEventListener("click", () => { void saveSelection(new Set()); });

    const rows = entries.map((entry) => {
      const row = document.createElement("div");
      row.className = "style-list-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "style-list-picker";
      checkbox.checked = selectedStyleIds.has(entry.id);
      checkbox.disabled = selectionSaving;
      checkbox.setAttribute("aria-label", `${t("library.style-selection-use")}: ${entry.name}`);
      checkbox.addEventListener("change", () => {
        const next = new Set(selectedStyleIds);
        if (checkbox.checked) next.add(entry.id);
        else next.delete(entry.id);
        void saveSelection(next);
      });

      const button = document.createElement("button");
      button.type = "button";
      button.className = `style-list-item${entry.id === selected ? " active" : ""}`;
      button.setAttribute("aria-pressed", String(entry.id === selected));
      button.innerHTML = `<img class="style-list-preview" alt="" loading="lazy"><span><strong></strong><small></small></span>`;
      const preview = button.querySelector<HTMLImageElement>(".style-list-preview")!;
      preview.src = entry.preview;
      preview.alt = entry.name;
      button.querySelector("strong")!.textContent = entry.name;
      button.querySelector("small")!.textContent = `v${entry.latestVersion} · ${t(statusLabel(entry.status))}`;
      button.title = entry.summary;
      button.addEventListener("click", () => { void select(entry.id); });
      row.append(checkbox, button);
      return row;
    });
    panel.navigation.replaceChildren(summary, ...rows);
  };

  const refresh = async (): Promise<void> => {
    showStatus(t("library.style-loading"));
    heading.textContent = uiLabel("library.styles");
    try {
      const [response, selectionResponse] = await Promise.all([
        fetch("/__studio/style-library"),
        fetch("/__studio/style-library/selection"),
      ]);
      const value = await response.json() as { readonly styles?: readonly StyleEntry[]; readonly error?: string };
      if (!response.ok || value.styles === undefined) throw new Error(value.error ?? "Style library unavailable");
      const selection = await selectionResponse.json() as StyleSelection & { readonly error?: string };
      if (!selectionResponse.ok || selection.error !== undefined) {
        throw new Error(selection.error ?? "Style selection unavailable");
      }
      entries = value.styles;
      selectedStyleIds.clear();
      for (const style of selection.styles) selectedStyleIds.add(style.id);
      selectionError = undefined;
      loaded = true;
      showStatus();
      if (selected === undefined || !entries.some((entry) => entry.id === selected)) {
        selected = entries[0]?.id;
        detail = undefined;
      }
      renderList();
      if (selected === undefined) renderDetail();
      else await select(selected);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error));
      renderDetail();
    }
  };

  panel.toolbar.querySelector("[data-style-refresh]")!.addEventListener("click", () => { void refresh(); });
  renderDetail();
  return {
    element: panel.element,
    refresh,
    activate() {
      if (!loaded) void refresh();
    },
  };
}

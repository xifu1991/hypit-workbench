import type { StudioSnapshot } from "../shared.js";
import { t, uiAttribute, uiLabel, uiText, type Message } from "./i18n.js";
import { icon } from "./icons.js";
import { createSidebarPanel } from "./sidebar-panel.js";

type StyleStatus = "analyzed" | "draft" | "retired" | "verified";
type StyleCategory = "all" | "presenter" | "product" | "material" | "graphic" | "editorial";

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

type CategoryDefinition = {
  readonly id: StyleCategory;
  readonly label: Message;
};

export type StylesPane = {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
  show(snapshot: StudioSnapshot): void;
  activate(): void;
};

const categories: readonly CategoryDefinition[] = [
  { id: "all", label: "library.style-category-all" },
  { id: "presenter", label: "library.style-category-presenter" },
  { id: "product", label: "library.style-category-product" },
  { id: "material", label: "library.style-category-material" },
  { id: "graphic", label: "library.style-category-graphic" },
  { id: "editorial", label: "library.style-category-editorial" },
];

const featuredStyleId = "armani-yulong-clean-talk";

const knownCategories: Readonly<Record<string, Exclude<StyleCategory, "all">>> = {
  "armani-yulong-clean-talk": "presenter",
  "full-frame-presenter": "presenter",
  "black-rectangle-pip-title": "graphic",
  "black-circle-pip-scene-tags": "graphic",
  "product-follow-label": "product",
  "product-hero-speaker-pip": "product",
  "rose-wall-presenter": "presenter",
  "archive-authority-insert": "editorial",
  "black-product-hero-still": "product",
  "rose-macro-evidence": "material",
  "thorn-truffle-drama": "material",
  "ingredient-color-matrix": "material",
  "question-grid-suspense": "graphic",
  "art-deconstruction-collage": "editorial",
  "retro-editorial-beauty": "editorial",
  "black-gold-premium-finale": "product",
};

function statusLabel(status: StyleStatus): Message {
  if (status === "verified") return "library.style-status-verified";
  if (status === "analyzed") return "library.style-status-analyzed";
  if (status === "retired") return "library.style-status-retired";
  return "library.style-status-draft";
}

function categoryOf(entry: StyleEntry): Exclude<StyleCategory, "all"> {
  const known = knownCategories[entry.id];
  if (known !== undefined) return known;
  if (entry.tags.some((tag) => ["真人", "口播", "主播"].includes(tag))) return "presenter";
  if (entry.tags.some((tag) => ["产品", "产品特写", "产品阵列", "品牌"].includes(tag))) return "product";
  if (entry.tags.some((tag) => ["原料", "玫瑰", "花材", "香调"].includes(tag))) return "material";
  if (entry.tags.some((tag) => ["黑底", "图形", "标签", "标题", "网格"].includes(tag))) return "graphic";
  return "editorial";
}

function previewUrls(detail: StyleDetail): readonly string[] {
  if (detail.assets.evidence.length >= 3) return detail.assets.evidence.slice(0, 3);
  const urls = [detail.assets.preview, ...detail.assets.evidence];
  return urls.filter((url, index) => urls.indexOf(url) === index).slice(0, 3);
}

export function createStylesPane(): StylesPane {
  const panel = createSidebarPanel("layers", "library.style-categories");
  panel.toolbar.innerHTML = `<span class="code-location" data-style-heading>${uiLabel("library.style-library-title")}</span>
    <button type="button" class="library-refresh" data-style-refresh ${uiAttribute("aria-label", "library.refresh-styles")} ${uiAttribute("title", "common.refresh")}>${icon("refresh")}</button>`;
  panel.content.innerHTML = `<div class="media-status" data-style-status role="status" hidden></div>
    <div class="smart-style-page">
      <section class="style-effect-panel" data-style-detail></section>
      <aside class="style-name-rail" data-style-name-rail hidden></aside>
    </div>`;
  const heading = panel.toolbar.querySelector<HTMLElement>("[data-style-heading]")!;
  const status = panel.content.querySelector<HTMLElement>("[data-style-status]")!;
  const detailNode = panel.content.querySelector<HTMLElement>("[data-style-detail]")!;
  const nameRail = panel.content.querySelector<HTMLElement>("[data-style-name-rail]")!;
  let entries: readonly StyleEntry[] = [];
  let selected: string | undefined;
  let detail: StyleDetail | undefined;
  let category: StyleCategory = "all";
  let loaded = false;
  let request = 0;
  const selectedStyleIds = new Set<string>();
  let selectionSaving = false;
  let selectionError: string | undefined;

  const showStatus = (message?: string): void => {
    status.hidden = message === undefined;
    status.textContent = message ?? "";
  };

  const visibleEntries = (): readonly StyleEntry[] => {
    const featured = entries.filter((entry) => entry.id === featuredStyleId);
    if (featured.length > 0) return featured;
    return category === "all"
      ? entries.slice(0, 1)
      : entries.filter((entry) => categoryOf(entry) === category).slice(0, 1);
  };

  const renderEmptyDetail = (): void => {
    detailNode.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${icon("layers")}</span><strong></strong><p></p></div>`;
    uiText(detailNode.querySelector("strong")!, entries.length === 0 ? "library.no-styles" : "library.style-no-category");
    uiText(detailNode.querySelector("p")!, entries.length === 0 ? "library.style-empty-hint" : "library.style-category-empty-hint");
  };

  const renderDetail = (): void => {
    if (detail === undefined) {
      renderEmptyDetail();
      return;
    }
    const currentDetail = detail;
    const urls = previewUrls(currentDetail);
    const applied = selectedStyleIds.has(currentDetail.entry.id);
    detailNode.innerHTML = `
      <header class="smart-style-intro">
        <span>${uiLabel("library.smart-style-choose")}</span>
        <p>${uiLabel("library.smart-style-description")}</p>
      </header>
      <div class="smart-style-grid">
        <button type="button" class="smart-style-card" aria-pressed="${String(applied)}">
          <span class="smart-style-thumb">
            <img alt="">
            <span class="smart-style-check">${icon("check")}</span>
          </span>
          <span class="smart-style-label">${uiLabel("library.smart-style-product")}</span>
          <small>${uiLabel("library.smart-style-product-detail")}</small>
        </button>
      </div>
      <footer class="smart-style-footer">
        <span class="smart-style-state">${applied ? uiLabel("library.smart-style-applied") : uiLabel("library.style-selection-none")}</span>
        <button type="button" class="smart-style-clear"${applied ? "" : " disabled"}>${uiLabel("library.style-selection-clear")}</button>
      </footer>`;

    const image = detailNode.querySelector<HTMLImageElement>(".smart-style-thumb img")!;
    image.src = urls[0] ?? currentDetail.assets.preview;
    image.alt = t("library.smart-style-product");
    image.loading = "eager";

    const card = detailNode.querySelector<HTMLButtonElement>(".smart-style-card")!;
    card.disabled = selectionSaving;
    card.addEventListener("click", () => {
      if (!selectedStyleIds.has(currentDetail.entry.id)) {
        void saveSelection(new Set([currentDetail.entry.id]));
      }
    });
    const clear = detailNode.querySelector<HTMLButtonElement>(".smart-style-clear")!;
    clear.addEventListener("click", () => {
      if (selectedStyleIds.has(currentDetail.entry.id)) void saveSelection(new Set());
    });
  };

  const select = async (id: string): Promise<void> => {
    selected = id;
    heading.textContent = t("library.style-library-title");
    showStatus(t("library.style-loading-detail"));
    renderNameRail();
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
      renderDetail();
    }
  };

  const saveSelection = async (ids: ReadonlySet<string>): Promise<void> => {
    selectionSaving = true;
    selectionError = undefined;
    renderNameRail();
    renderDetail();
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
      renderNameRail();
      renderDetail();
    }
  };

  const renderCategories = (): void => {
    panel.navigation.replaceChildren(...categories.map((definition) => {
      const count = definition.id === "all"
        ? entries.length
        : entries.filter((entry) => categoryOf(entry) === definition.id).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `style-category-tab${definition.id === category ? " active" : ""}`;
      button.setAttribute("aria-pressed", String(definition.id === category));
      button.innerHTML = `<span></span><small>${count}</small>`;
      uiText(button.querySelector("span")!, definition.label);
      button.addEventListener("click", () => {
        if (category === definition.id) return;
        category = definition.id;
        const next = visibleEntries();
        renderCategories();
        if (selected === undefined || !next.some((entry) => entry.id === selected)) {
          if (next[0] === undefined) {
            selected = undefined;
            detail = undefined;
            heading.textContent = t("library.style-library-title");
            renderNameRail();
            renderDetail();
          } else {
            void select(next[0].id);
          }
        } else {
          renderNameRail();
        }
      });
      return button;
    }));
  };

  const renderNameRail = (): void => {
    const shown = visibleEntries();
    const header = document.createElement("div");
    header.className = "style-name-rail-head";
    header.innerHTML = `<div><strong>${uiLabel("library.style-name-rail")}</strong><span></span></div><button type="button"></button>`;
    const state = header.querySelector("span")!;
    if (selectionSaving) uiText(state, "library.style-selection-saving");
    else if (selectionError !== undefined) {
      state.removeAttribute("data-ui-text");
      state.textContent = selectionError;
      state.classList.add("error");
    } else if (selectedStyleIds.size === 0) uiText(state, "library.style-selection-none");
    else uiText(state, "library.style-selection-count", { count: selectedStyleIds.size });
    const clear = header.querySelector<HTMLButtonElement>("button")!;
    uiText(clear, "library.style-selection-clear");
    clear.disabled = selectionSaving || selectedStyleIds.size === 0;
    clear.addEventListener("click", () => { void saveSelection(new Set()); });

    const list = document.createElement("div");
    list.className = "style-name-list";
    if (shown.length === 0) {
      const empty = document.createElement("p");
      empty.className = "style-name-empty";
      uiText(empty, loaded ? "library.style-no-category" : "library.style-loading");
      list.append(empty);
    } else {
      for (const entry of shown) {
        const row = document.createElement("div");
        row.className = `style-name-row${entry.id === selected ? " active" : ""}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
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
        button.className = "style-name-button";
        button.setAttribute("aria-pressed", String(entry.id === selected));
        button.innerHTML = `<strong></strong><small></small>`;
        button.querySelector("strong")!.textContent = entry.name;
        button.querySelector("small")!.textContent = `v${entry.latestVersion} · ${t(statusLabel(entry.status))}`;
        button.title = entry.summary;
        button.addEventListener("click", () => { void select(entry.id); });
        row.append(checkbox, button);
        list.append(row);
      }
    }
    nameRail.replaceChildren(header, list);
    list.querySelector<HTMLElement>(".style-name-row.active")?.scrollIntoView({ block: "nearest" });
  };

  const refresh = async (): Promise<void> => {
    showStatus(t("library.style-loading"));
    heading.textContent = t("library.style-library-title");
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
      const shown = visibleEntries();
      if (selectedStyleIds.size === 0 && entries.some((entry) => entry.id === featuredStyleId)) {
        await saveSelection(new Set([featuredStyleId]));
      }
      if (selected === undefined || !shown.some((entry) => entry.id === selected)) {
        selected = shown[0]?.id;
        detail = undefined;
      } else {
        detail = undefined;
      }
      renderCategories();
      renderNameRail();
      if (selected === undefined) renderDetail();
      else await select(selected);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error));
      renderCategories();
      renderNameRail();
      renderDetail();
    }
  };

  panel.toolbar.querySelector("[data-style-refresh]")!.addEventListener("click", () => { void refresh(); });
  renderCategories();
  renderNameRail();
  renderDetail();
  return {
    element: panel.element,
    show() {},
    refresh,
    activate() {
      if (!loaded) void refresh();
    },
  };
}

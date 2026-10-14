import type { StudioSnapshot } from "../shared.js";
import { t, uiAttribute, uiLabel, uiText } from "./i18n.js";
import type { Message } from "./i18n.js";
import { icon } from "./icons.js";
import { createSidebarPanel } from "./sidebar-panel.js";

type StyleStatus = "analyzed" | "draft" | "retired" | "verified";
type StyleMode = "product" | "manhua" | "tech";

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
  show(snapshot: StudioSnapshot): void;
  activate(): void;
};

const productStyleId = "armani-yulong-clean-talk";
const manhuaPreviewStyleId = "black-circle-pip-scene-tags";
const techPreviewStyleId = "tech-share-chapter-progress";
// Styles carrying this tag belong to the tech-sharing mode; they are kept out of
// the product-explainer list so the two libraries do not mix.
const techStyleTag = "技术分享";

export function createStylesPane(): StylesPane {
  const panel = createSidebarPanel("layers", "library.style-categories");
  panel.toolbar.innerHTML = `<span class="code-location" data-style-heading>${uiLabel("library.style-library-title")}</span>
    <button type="button" class="library-refresh" data-style-refresh ${uiAttribute("aria-label", "library.refresh-styles")} ${uiAttribute("title", "common.refresh")}>${icon("refresh")}</button>`;
  panel.content.innerHTML = `<div class="media-status" data-style-status role="status" hidden></div>
    <div class="smart-style-page">
      <section class="smart-style-main" data-style-detail></section>
    </div>`;
  const heading = panel.toolbar.querySelector<HTMLElement>("[data-style-heading]")!;
  const status = panel.content.querySelector<HTMLElement>("[data-style-status]")!;
  const detailNode = panel.content.querySelector<HTMLElement>("[data-style-detail]")!;
  let entries: readonly StyleEntry[] = [];
  let loaded = false;
  let request = 0;
  const selectedStyleIds = new Set<string>();
  let selectionSaving = false;
  let selectionError: string | undefined;
  let mode: StyleMode = "product";

  const showStatus = (message?: string): void => {
    status.hidden = message === undefined;
    status.textContent = message ?? "";
  };

  const renderEmpty = (): void => {
    detailNode.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${icon("layers")}</span><strong></strong><p></p></div>`;
    uiText(detailNode.querySelector("strong")!, entries.length === 0 ? "library.no-styles" : "library.style-no-category");
    uiText(detailNode.querySelector("p")!, entries.length === 0 ? "library.style-empty-hint" : "library.style-category-empty-hint");
  };

  const renderDetail = (): void => {
    if (entries.length === 0) {
      renderEmpty();
      return;
    }
    const product = entries.find((entry) => entry.id === productStyleId) ?? entries[0];
    const manhua = entries.find((entry) => entry.id === manhuaPreviewStyleId)
      ?? entries.find((entry) => entry.id !== product?.id)
      ?? product;
    const tech = entries.find((entry) => entry.id === techPreviewStyleId)
      ?? entries.find((entry) => entry.tags.includes(techStyleTag))
      ?? entries.find((entry) => entry.id !== product?.id && entry.id !== manhua?.id)
      ?? product;
    if (product === undefined || manhua === undefined || tech === undefined) {
      renderEmpty();
      return;
    }
    detailNode.innerHTML = `
      <header class="smart-style-intro">
        <span>${uiLabel("library.smart-style-choose")}</span>
        <p>${uiLabel("library.smart-style-description")}</p>
      </header>
      <div class="smart-style-grid"></div>
      <section class="smart-style-decomposed">
        <header>
          <span>${uiLabel("library.smart-style-decomposed")}</span>
          <small></small>
        </header>
        <p class="smart-style-decomposed-hint"></p>
        <div class="smart-style-decomposed-grid"></div>
      </section>`;
    const grid = detailNode.querySelector<HTMLElement>(".smart-style-grid")!;
    const options = [
      { id: "product" as const, entry: product, label: "library.smart-style-product" as const },
      { id: "manhua" as const, entry: manhua, label: "library.smart-style-manhua" as const },
      { id: "tech" as const, entry: tech, label: "library.smart-style-tech" as const },
    ];
    grid.replaceChildren(...options.map(({ id, entry, label }) => {
      const applied = mode === id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "smart-style-card";
      card.setAttribute("aria-pressed", String(applied));
      card.title = entry.summary;
      card.disabled = selectionSaving;
      card.innerHTML = `
        <span class="smart-style-thumb">
          <img alt="">
          <span class="smart-style-check">${icon("check")}</span>
        </span>
        <span class="smart-style-label"></span>`;
      const image = card.querySelector<HTMLImageElement>("img")!;
      image.src = entry.preview;
      image.alt = t(label);
      image.loading = "eager";
      uiText(card.querySelector<HTMLElement>(".smart-style-label")!, label);
      card.addEventListener("click", () => {
        if (mode === id) return;
        mode = id;
        renderDetail();
      });
      return card;
    }));

    const decomposedGrid = detailNode.querySelector<HTMLElement>(".smart-style-decomposed-grid")!;
    const renderPending = (title: Message, detail: Message, hint: Message): void => {
      uiText(detailNode.querySelector(".smart-style-decomposed header small")!, "library.smart-style-pending");
      uiText(detailNode.querySelector(".smart-style-decomposed-hint")!, hint);
      const empty = document.createElement("div");
      empty.className = "smart-style-decomposed-empty";
      empty.innerHTML = `<span>${icon("plus")}</span><strong></strong><p></p>`;
      uiText(empty.querySelector("strong")!, title);
      uiText(empty.querySelector("p")!, detail);
      decomposedGrid.replaceChildren(empty);
    };
    const techStyles = entries.filter((entry) => entry.tags.includes(techStyleTag));
    const listed = mode === "tech"
      ? techStyles
      : entries.filter((entry) => !entry.tags.includes(techStyleTag));
    if (mode === "manhua") {
      renderPending(
        "library.smart-style-decomposed-manhua",
        "library.smart-style-decomposed-manhua-detail",
        "library.smart-style-decomposed-manhua-hint",
      );
    } else if (listed.length === 0) {
      renderPending(
        "library.smart-style-decomposed-tech",
        "library.smart-style-decomposed-tech-detail",
        "library.smart-style-decomposed-tech-hint",
      );
    } else {
      uiText(
        detailNode.querySelector(".smart-style-decomposed header small")!,
        "library.smart-style-decomposed-count",
        { count: listed.length },
      );
      uiText(
        detailNode.querySelector(".smart-style-decomposed-hint")!,
        mode === "tech" ? "library.smart-style-decomposed-tech" : "library.smart-style-decomposed-product",
      );
      const shown = [...listed].sort((left, right) => {
        if (left.id === productStyleId) return -1;
        if (right.id === productStyleId) return 1;
        return left.name.localeCompare(right.name, "zh-CN");
      });
      decomposedGrid.replaceChildren(...shown.map((entry) => {
        const applied = selectedStyleIds.has(entry.id);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "smart-style-decomposed-card";
        card.setAttribute("aria-pressed", String(applied));
        card.title = entry.summary;
        card.disabled = selectionSaving;
        card.innerHTML = `
          <span class="smart-style-decomposed-thumb">
            <img alt="">
            <span class="smart-style-check">${icon("check")}</span>
          </span>
          <span class="smart-style-decomposed-label"></span>`;
        const image = card.querySelector<HTMLImageElement>("img")!;
        image.src = entry.preview;
        image.alt = entry.name;
        image.loading = "lazy";
        card.querySelector<HTMLElement>(".smart-style-decomposed-label")!.textContent = entry.name;
        card.addEventListener("click", () => {
          if (selectedStyleIds.size === 1 && selectedStyleIds.has(entry.id)) return;
          void saveSelection(new Set([entry.id]));
        });
        return card;
      }));
    }
  };

  const saveSelection = async (ids: ReadonlySet<string>): Promise<void> => {
    selectionSaving = true;
    selectionError = undefined;
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
      if (selectionError === undefined) showStatus();
      else showStatus(selectionError);
      renderDetail();
    }
  };

  const refresh = async (): Promise<void> => {
    showStatus(t("library.style-loading"));
    heading.textContent = t("library.style-library-title");
    const current = ++request;
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
      if (current !== request) return;
      entries = value.styles;
      selectedStyleIds.clear();
      for (const style of selection.styles) selectedStyleIds.add(style.id);
      loaded = true;
      showStatus();
      renderDetail();
      if (selectedStyleIds.size === 0 && entries.some((entry) => entry.id === productStyleId)) {
        await saveSelection(new Set([productStyleId]));
      }
    } catch (error) {
      if (current !== request) return;
      showStatus(error instanceof Error ? error.message : String(error));
      renderDetail();
    }
  };

  panel.toolbar.querySelector("[data-style-refresh]")!.addEventListener("click", () => { void refresh(); });
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

import type {
  StickerLibraryEntry,
  StickerPlacement,
  StickerRecommendation,
  StickerTextMode,
  StickerTimedWord,
} from "../sticker-library.js";
import type { StudioSnapshot } from "../shared.js";
import { icon } from "./icons.js";
import { t, uiAttribute, uiAttr, uiLabel, uiText, type Message } from "./i18n.js";

type StickerEntry = StickerLibraryEntry & { readonly url: string };

type StickerSelection = {
  readonly format: "hypit.sticker-selection@1";
  readonly updatedAt: string | null;
  readonly stickers: readonly {
    readonly id: string;
    readonly name: string;
    readonly file: string;
    readonly mediaType: string;
    readonly textMode: StickerTextMode;
    readonly tags: readonly string[];
    readonly suggestedText?: string;
    readonly placement?: StickerPlacement;
  }[];
};

type PendingUpload = {
  readonly file: File;
  name: string;
  tags: string;
  textMode: StickerTextMode;
};

export type StickersPane = {
  readonly element: HTMLElement;
  show(snapshot: StudioSnapshot): void;
  refresh(): Promise<void>;
  activate(): void;
};

function shortBytes(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function textModeLabel(mode: StickerTextMode): Message {
  if (mode === "fixed") return "library.sticker-text-fixed";
  if (mode === "none") return "library.sticker-text-none";
  return "library.sticker-text-blank";
}

function setTextModeOptions(select: HTMLSelectElement, selected: StickerTextMode): void {
  select.replaceChildren(...(["blank", "fixed", "none"] as const).map((mode) => {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = t(textModeLabel(mode));
    option.selected = mode === selected;
    return option;
  }));
  select.value = selected;
}

function mediaElement(entry: StickerEntry, className: string): HTMLElement {
  if (entry.mediaType === "video/webm") {
    const video = document.createElement("video");
    video.className = className;
    video.src = entry.url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    return video;
  }
  const image = document.createElement("img");
  image.className = className;
  image.src = entry.url;
  image.alt = entry.name;
  image.loading = "lazy";
  return image;
}

function timedWords(snapshot: StudioSnapshot | undefined): readonly StickerTimedWord[] {
  if (snapshot?.script === undefined || snapshot.script.tokens.length === 0) return [];
  const text = snapshot.source.files.find((file) => file.path === snapshot.script!.sourcePath)?.text
    ?? snapshot.source.text;
  const fps = snapshot.space.frameRate.numerator / snapshot.space.frameRate.denominator;
  return snapshot.script.tokens.flatMap((token) => {
    const word = text.slice(token.range.start, token.range.end).replace(/<[^>]*>/gu, "").trim();
    if (word.length === 0) return [];
    return [{
      text: word,
      startSec: token.startFrame / fps,
      endSec: token.endFrame / fps,
    }];
  });
}

export function createStickersPane(): StickersPane {
  const element = document.createElement("section");
  element.className = "sticker-pane";
  element.innerHTML = `
    <div class="sticker-toolbar">
      <span class="sticker-heading">${uiLabel("library.stickers")}</span>
      <div class="sticker-toolbar-actions">
        <button type="button" class="sticker-match" ${uiAttribute("title", "library.sticker-match")} ${uiAttribute("aria-label", "library.sticker-match")}>${icon("check")}</button>
        <button type="button" class="sticker-upload-trigger" ${uiAttribute("title", "library.sticker-upload")} ${uiAttribute("aria-label", "library.sticker-upload")}>${icon("upload")}</button>
        <button type="button" class="sticker-refresh" data-sticker-refresh ${uiAttribute("title", "common.refresh")} ${uiAttribute("aria-label", "library.refresh-stickers")}>${icon("refresh")}</button>
      </div>
    </div>
    <div class="sticker-search"><input type="search" data-sticker-search></div>
    <div class="sticker-tag-strip" data-sticker-tags></div>
    <div class="sticker-status media-status" data-sticker-status role="status" hidden></div>
    <div class="sticker-upload-sheet" data-sticker-upload-sheet hidden></div>
    <div class="sticker-selection" data-sticker-selection></div>
    <div class="sticker-grid" data-sticker-grid></div>
    <dialog class="sticker-dialog" data-sticker-dialog>
      <form method="dialog" class="sticker-dialog-form" data-sticker-dialog-form></form>
    </dialog>
    <input type="file" data-sticker-file hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/webm">`;

  const matchButton = element.querySelector<HTMLButtonElement>(".sticker-match")!;
  const uploadButton = element.querySelector<HTMLButtonElement>(".sticker-upload-trigger")!;
  const fileInput = element.querySelector<HTMLInputElement>("[data-sticker-file]")!;
  const search = element.querySelector<HTMLInputElement>("[data-sticker-search]")!;
  const tagStrip = element.querySelector<HTMLElement>("[data-sticker-tags]")!;
  const status = element.querySelector<HTMLElement>("[data-sticker-status]")!;
  const uploadSheet = element.querySelector<HTMLElement>("[data-sticker-upload-sheet]")!;
  const selectionNode = element.querySelector<HTMLElement>("[data-sticker-selection]")!;
  const grid = element.querySelector<HTMLElement>("[data-sticker-grid]")!;
  const dialog = element.querySelector<HTMLDialogElement>("[data-sticker-dialog]")!;
  const dialogForm = element.querySelector<HTMLFormElement>("[data-sticker-dialog-form]")!;
  let entries: readonly StickerEntry[] = [];
  let snapshot: StudioSnapshot | undefined;
  let activeTag = "";
  let query = "";
  let selectedIds = new Set<string>();
  let placements = new Map<string, StickerPlacement>();
  let suggestedTexts = new Map<string, string>();
  let recommendations = new Map<string, StickerRecommendation>();
  let pending: PendingUpload[] = [];
  let loaded = false;
  let request = 0;
  let saving = false;

  const setStatus = (message?: Message | string): void => {
    status.hidden = message === undefined;
    status.textContent = typeof message === "string" ? message : message === undefined ? "" : t(message);
  };

  const visibleEntries = (): readonly StickerEntry[] => {
    const needle = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (activeTag.length > 0 && !entry.tags.includes(activeTag)) return false;
      if (needle.length === 0) return true;
      return [entry.name, ...entry.tags].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  };

  const saveSelection = async (): Promise<void> => {
    saving = true;
    renderSelection();
    renderGrid();
    try {
      const response = await fetch("/__studio/sticker-library/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [...selectedIds],
          placements: Object.fromEntries([...selectedIds].flatMap((id) => {
            const selectedPlacement = placements.get(id);
            return selectedPlacement === undefined ? [] : [[id, selectedPlacement]];
          })),
          suggestedTexts: Object.fromEntries([...selectedIds].flatMap((id) => {
            const suggestedText = suggestedTexts.get(id);
            return suggestedText === undefined ? [] : [[id, suggestedText]];
          })),
        }),
      });
      const value = await response.json() as StickerSelection & { readonly error?: string };
      if (!response.ok || value.error !== undefined) throw new Error(value.error ?? t("library.unavailable"));
      selectedIds = new Set(value.stickers.map((entry) => entry.id));
      placements = new Map(value.stickers.flatMap((entry) => entry.placement === undefined ? [] : [[entry.id, entry.placement]]));
      suggestedTexts = new Map(value.stickers.flatMap((entry) => entry.suggestedText === undefined ? [] : [[entry.id, entry.suggestedText]]));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
      renderSelection();
      renderGrid();
    }
  };

  const toggleSelection = (id: string, selected: boolean): void => {
    const next = new Set(selectedIds);
    if (selected) next.add(id);
    else {
      next.delete(id);
      placements.delete(id);
      suggestedTexts.delete(id);
    }
    selectedIds = next;
    renderSelection();
    renderGrid();
    void saveSelection();
  };

  const openPreview = (entry: StickerEntry): void => {
    dialogForm.innerHTML = `
      <div class="sticker-dialog-head">
        <div><strong></strong><span></span></div>
        <button type="button" class="sticker-dialog-close" ${uiAttribute("aria-label", "common.cancel")}>${icon("close")}</button>
      </div>
      <div class="sticker-dialog-preview"></div>
      <label class="sticker-field"><span>${uiLabel("library.sticker-name")}</span><input type="text" data-sticker-edit-name maxlength="80"></label>
      <label class="sticker-field"><span>${uiLabel("library.sticker-text-mode")}</span><select data-sticker-edit-text-mode></select></label>
      <label class="sticker-field"><span>${uiLabel("library.sticker-tags")}</span><input type="text" data-sticker-edit-tags ${uiAttribute("placeholder", "library.sticker-tags-placeholder")}></label>
      <div class="sticker-dialog-actions">
        <button type="button" class="sticker-secondary" data-sticker-dialog-cancel>${uiLabel("common.cancel")}</button>
        <button type="button" class="sticker-primary" data-sticker-dialog-save>${uiLabel("common.save")}</button>
      </div>`;
    const name = dialogForm.querySelector<HTMLInputElement>("[data-sticker-edit-name]")!;
    const textMode = dialogForm.querySelector<HTMLSelectElement>("[data-sticker-edit-text-mode]")!;
    const tags = dialogForm.querySelector<HTMLInputElement>("[data-sticker-edit-tags]")!;
    dialogForm.querySelector("strong")!.textContent = entry.name;
    dialogForm.querySelector("span")!.textContent = `${entry.kind === "animated" ? t("library.sticker-animated") : t("library.sticker-static")}${entry.size === undefined ? "" : ` · ${shortBytes(entry.size)}`}`;
    dialogForm.querySelector(".sticker-dialog-preview")!.append(mediaElement(entry, "sticker-dialog-media"));
    name.value = entry.name;
    setTextModeOptions(textMode, entry.textMode);
    tags.value = entry.tags.join(", ");
    dialogForm.querySelector("[data-sticker-dialog-cancel]")!.addEventListener("click", () => dialog.close());
    dialogForm.querySelector(".sticker-dialog-close")!.addEventListener("click", () => dialog.close());
    dialogForm.querySelector("[data-sticker-dialog-save]")!.addEventListener("click", () => {
      const nextName = name.value.trim();
      if (nextName.length === 0) return;
      const save = dialogForm.querySelector<HTMLButtonElement>("[data-sticker-dialog-save]")!;
      save.disabled = true;
      uiText(save, "common.saving");
      void fetch("/__studio/sticker-library/metadata", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, name: nextName, textMode: textMode.value, tags: tags.value }),
      }).then(async (response) => {
        const value = await response.json() as StickerEntry & { readonly error?: string };
        if (!response.ok || value.error !== undefined) throw new Error(value.error ?? t("library.unavailable"));
        entries = entries.map((candidate) => candidate.id === value.id ? value : candidate);
        dialog.close();
        render();
      }).catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        save.disabled = false;
        uiText(save, "common.save");
      });
    });
    dialog.showModal();
  };

  const renderGrid = (): void => {
    const shown = visibleEntries();
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.innerHTML = `<span class="library-empty-icon">${icon("sticker")}</span><strong></strong><p></p>`;
      uiText(empty.querySelector("strong")!, entries.length === 0 ? "library.no-stickers" : "library.no-stickers-filter");
      uiText(empty.querySelector("p")!, entries.length === 0 ? "library.sticker-empty-hint" : "library.sticker-filter-hint");
      grid.replaceChildren(empty);
      return;
    }
    grid.replaceChildren(...shown.map((entry) => {
      const card = document.createElement("article");
      card.className = `sticker-card${selectedIds.has(entry.id) ? " selected" : ""}`;
      card.dataset.stickerId = entry.id;
      const pick = document.createElement("label");
      pick.className = "sticker-pick";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(entry.id);
      checkbox.disabled = saving;
      checkbox.setAttribute("aria-label", `${t("library.sticker-use")}: ${entry.name}`);
      checkbox.addEventListener("change", () => toggleSelection(entry.id, checkbox.checked));
      pick.append(checkbox, document.createElement("span"));
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "sticker-preview-button";
      preview.setAttribute("aria-label", `${t("library.sticker-preview")}: ${entry.name}`);
      preview.append(mediaElement(entry, "sticker-preview-media"));
      preview.addEventListener("click", () => openPreview(entry));
      const copy = document.createElement("div");
      copy.className = "sticker-card-copy";
      const title = document.createElement("strong");
      title.textContent = entry.name;
      const tags = document.createElement("span");
      tags.textContent = entry.tags.slice(0, 3).join(" · ") || t("library.sticker-untagged");
      const textMode = document.createElement("span");
      textMode.className = "sticker-text-mode";
      textMode.textContent = t(textModeLabel(entry.textMode));
      copy.append(title, textMode, tags);
      const recommendation = recommendations.get(entry.id);
      if (recommendation !== undefined && recommendation.score > 0) {
        const match = document.createElement("span");
        match.className = "sticker-match-score";
        match.textContent = `${t("library.sticker-recommended")} ${Math.round(recommendation.score)}`;
        match.title = recommendation.matchedTerms.join(" · ");
        copy.append(match);
      }
      card.append(pick, preview, copy);
      return card;
    }));
  };

  const renderSelection = (): void => {
    selectionNode.innerHTML = `<div><strong></strong><span></span></div><button type="button" class="sticker-selection-clear"></button>`;
    uiText(selectionNode.querySelector("strong")!, "library.sticker-selection-title");
    const state = selectionNode.querySelector("span")!;
    if (saving) uiText(state, "common.saving");
    else if (selectedIds.size === 0) uiText(state, "library.sticker-selection-none");
    else uiText(state, "library.sticker-selection-count", { count: selectedIds.size });
    const clear = selectionNode.querySelector<HTMLButtonElement>(".sticker-selection-clear")!;
    uiText(clear, "library.sticker-selection-clear");
    clear.disabled = saving || selectedIds.size === 0;
    clear.addEventListener("click", () => {
      selectedIds = new Set();
      placements = new Map();
      renderSelection();
      renderGrid();
      void saveSelection();
    });
  };

  const renderTags = (): void => {
    const counts = new Map<string, number>();
    for (const entry of entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const entriesToShow: readonly [string, number][] = [
      [t("library.sticker-all"), entries.length],
      ...[...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    ];
    tagStrip.replaceChildren(...entriesToShow.map(([tag, count], index) => {
      const button = document.createElement("button");
      const value = index === 0 ? "" : tag;
      button.type = "button";
      button.className = `sticker-tag${value === activeTag ? " active" : ""}`;
      button.setAttribute("aria-pressed", String(value === activeTag));
      button.innerHTML = `<span></span><em>${count}</em>`;
      button.querySelector("span")!.textContent = tag;
      button.title = `${tag} · ${count}`;
      button.addEventListener("click", () => {
        activeTag = value;
        renderTags();
        renderGrid();
      });
      return button;
    }));
    const heading = element.querySelector<HTMLElement>(".sticker-heading")!;
    heading.textContent = activeTag.length === 0 ? t("library.stickers") : activeTag;
  };

  const renderUploads = (): void => {
    uploadSheet.hidden = pending.length === 0;
    if (pending.length === 0) {
      uploadSheet.replaceChildren();
      return;
    }
    uploadSheet.innerHTML = `<div class="sticker-upload-head"><strong>${uiLabel("library.sticker-upload-title")}</strong><button type="button" data-sticker-upload-cancel>${uiLabel("common.cancel")}</button></div>
      <div class="sticker-upload-list"></div>
      <button type="button" class="sticker-primary sticker-upload-start">${uiLabel("library.sticker-upload-start")}</button>`;
    const list = uploadSheet.querySelector<HTMLElement>(".sticker-upload-list")!;
    list.replaceChildren(...pending.map((item, index) => {
      const row = document.createElement("div");
      row.className = "sticker-upload-row";
      row.innerHTML = `<div class="sticker-upload-file"><strong></strong><span></span></div>
        <label class="sticker-field"><span>${uiLabel("library.sticker-name")}</span><input type="text" data-upload-name maxlength="80"></label>
        <label class="sticker-field"><span>${uiLabel("library.sticker-text-mode")}</span><select data-upload-text-mode></select></label>
        <label class="sticker-field"><span>${uiLabel("library.sticker-tags")}</span><input type="text" data-upload-tags ${uiAttribute("placeholder", "library.sticker-tags-placeholder")}></label>
        <button type="button" class="sticker-remove-file" ${uiAttribute("title", "library.sticker-remove-file")}>${icon("trash")}</button>`;
      row.querySelector(".sticker-upload-file strong")!.textContent = item.file.name;
      row.querySelector(".sticker-upload-file span")!.textContent = `${item.file.type || "unknown"} · ${shortBytes(item.file.size)}`;
      const name = row.querySelector<HTMLInputElement>("[data-upload-name]")!;
      const textMode = row.querySelector<HTMLSelectElement>("[data-upload-text-mode]")!;
      const tags = row.querySelector<HTMLInputElement>("[data-upload-tags]")!;
      name.value = item.name;
      setTextModeOptions(textMode, item.textMode);
      tags.value = item.tags;
      name.addEventListener("input", () => { pending[index] = { ...pending[index]!, name: name.value }; });
      textMode.addEventListener("change", () => {
        pending[index] = { ...pending[index]!, textMode: textMode.value as StickerTextMode };
      });
      tags.addEventListener("input", () => { pending[index] = { ...pending[index]!, tags: tags.value }; });
      row.querySelector(".sticker-remove-file")!.addEventListener("click", () => {
        pending = pending.filter((_candidate, candidateIndex) => candidateIndex !== index);
        renderUploads();
      });
      return row;
    }));
    uploadSheet.querySelector("[data-sticker-upload-cancel]")!.addEventListener("click", () => {
      pending = [];
      renderUploads();
    });
    uploadSheet.querySelector(".sticker-upload-start")!.addEventListener("click", () => {
      const button = uploadSheet.querySelector<HTMLButtonElement>(".sticker-upload-start")!;
      button.disabled = true;
      uiText(button, "library.sticker-uploading");
      setStatus("library.sticker-uploading");
      void (async () => {
        for (const item of pending) {
          const form = new FormData();
          form.set("file", item.file);
          form.set("name", item.name);
          form.set("textMode", item.textMode);
          form.set("tags", item.tags);
          const response = await fetch("/__studio/sticker-library", { method: "POST", body: form });
          const value = await response.json() as StickerEntry & { readonly error?: string };
          if (!response.ok || value.error !== undefined) throw new Error(value.error ?? t("library.sticker-upload-failed"));
        }
        pending = [];
        setStatus("library.sticker-upload-complete");
        renderUploads();
        await refresh();
      })().catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        button.disabled = false;
        uiText(button, "library.sticker-upload-start");
      });
    });
  };

  const render = (): void => {
    renderTags();
    renderSelection();
    renderUploads();
    renderGrid();
  };

  const match = (): void => {
    const words = timedWords(snapshot);
    if (words.length === 0 || snapshot === undefined) {
      setStatus("library.sticker-no-script");
      return;
    }
    matchButton.disabled = true;
    setStatus("library.sticker-matching");
    void fetch("/__studio/sticker-library/recommend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ words, durationSec: snapshot.space.durationSec }),
    }).then(async (response) => {
      const value = await response.json() as { readonly recommendations?: readonly StickerRecommendation[]; readonly error?: string };
      if (!response.ok || value.recommendations === undefined) throw new Error(value.error ?? t("library.unavailable"));
      recommendations = new Map(value.recommendations.map((item) => [item.id, item]));
      const choices = value.recommendations.slice(0, 3).filter((item) => item.score >= 7);
      selectedIds = new Set([...selectedIds, ...choices.map((item) => item.id)]);
      placements = new Map([...placements, ...choices.map((item) => [item.id, item.placement] as const)]);
      suggestedTexts = new Map([...suggestedTexts, ...choices.flatMap((item) =>
        item.suggestedText === undefined ? [] : [[item.id, item.suggestedText] as const])]);
      setStatus(choices.length === 0 ? "library.sticker-match-none" : t("library.sticker-match-complete", { count: choices.length }));
      renderGrid();
      if (choices.length > 0) await saveSelection();
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      matchButton.disabled = false;
    });
  };

  const refresh = async (): Promise<void> => {
    setStatus("library.sticker-loading");
    const current = ++request;
    try {
      const [libraryResponse, selectionResponse] = await Promise.all([
        fetch("/__studio/sticker-library"),
        fetch("/__studio/sticker-library/selection"),
      ]);
      const library = await libraryResponse.json() as { readonly stickers?: readonly StickerEntry[]; readonly error?: string };
      if (!libraryResponse.ok || library.stickers === undefined) throw new Error(library.error ?? t("library.unavailable"));
      const selection = await selectionResponse.json() as StickerSelection & { readonly error?: string };
      if (!selectionResponse.ok || selection.error !== undefined) throw new Error(selection.error ?? t("library.unavailable"));
      if (current !== request) return;
      entries = library.stickers;
      selectedIds = new Set(selection.stickers.map((entry) => entry.id));
      placements = new Map(selection.stickers.flatMap((entry) => entry.placement === undefined ? [] : [[entry.id, entry.placement]]));
      suggestedTexts = new Map(selection.stickers.flatMap((entry) => entry.suggestedText === undefined ? [] : [[entry.id, entry.suggestedText]]));
      loaded = true;
      setStatus();
      render();
    } catch (error) {
      if (current !== request) return;
      setStatus(error instanceof Error ? error.message : String(error));
      render();
    }
  };

  search.addEventListener("input", () => { query = search.value; renderGrid(); });
  uploadButton.addEventListener("click", () => fileInput.click());
  matchButton.addEventListener("click", match);
  fileInput.addEventListener("change", () => {
    pending = [...pending, ...Array.from(fileInput.files ?? []).map((file) => ({
      file,
      name: fileNameWithoutExtension(file.name),
      tags: "",
      textMode: "blank" as const,
    }))];
    fileInput.value = "";
    renderUploads();
  });
  element.querySelector("[data-sticker-refresh]")!.addEventListener("click", () => { void refresh(); });
  render();
  return {
    element,
    show(value) {
      snapshot = value;
    },
    refresh,
    activate() {
      if (!loaded) void refresh();
    },
  };
}

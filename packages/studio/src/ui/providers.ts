import { t, uiAttr, uiAttribute, uiLabel, uiText, type Message } from "./i18n.js";
import { icon } from "./icons.js";
import { createSidebarPanel } from "./sidebar-panel.js";

type ProviderFieldView = {
  readonly key: string;
  readonly kind: "text" | "secret" | "boolean" | "number" | "choice";
  readonly label: string;
  readonly choices?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly placeholder?: string;
  readonly value: string | number | boolean | null;
  readonly stored: boolean;
};

type ProviderGroupView = {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ProviderFieldView[];
};

type ProviderSettingsView = {
  readonly format: "hypit.provider-settings@1";
  readonly path: string;
  readonly exists: boolean;
  readonly groups: readonly ProviderGroupView[];
  readonly remote: {
    readonly configured: boolean;
    readonly url: string | null;
    readonly pulledAt: string | null;
    readonly error: string | null;
  };
  readonly applied?: readonly string[];
  readonly refusedSecrets?: readonly string[];
};

type GatewayCheckView = {
  readonly ok: boolean;
  readonly tenant: {
    readonly id: string | null;
    readonly name: string | null;
    readonly status: string | null;
  };
  readonly wallet: {
    readonly balanceFen: number | null;
    readonly reservedFen: number | null;
    readonly availableFen: number | null;
  };
  readonly voiceCount: number;
  readonly defaultSpeaker: string | null;
  readonly checkedAt: string;
};

export type ProvidersPane = {
  readonly element: HTMLElement;
  activate(): void;
};

const fieldSelector = (group: string, key: string): string =>
  `[data-provider-group="${group}"][data-provider-key="${key}"]`;

function fieldControl(field: ProviderFieldView): HTMLElement {
  if (field.kind === "boolean") {
    const wrapper = document.createElement("span");
    wrapper.className = "provider-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = field.value === true;
    wrapper.append(input);
    return wrapper;
  }
  if (field.kind === "choice") {
    const select = document.createElement("select");
    for (const choice of field.choices ?? []) {
      const option = document.createElement("option");
      option.value = choice;
      option.textContent = choice;
      select.append(option);
    }
    select.value = typeof field.value === "string" ? field.value : (field.choices?.[0] ?? "");
    return select;
  }
  const input = document.createElement("input");
  input.type = field.kind === "number" ? "number" : field.kind === "secret" ? "password" : "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (field.minimum !== undefined) input.min = String(field.minimum);
  if (field.maximum !== undefined) input.max = String(field.maximum);
  if (field.placeholder !== undefined) input.placeholder = field.placeholder;
  if (field.kind === "secret") {
    input.dataset.providerSecret = "true";
    if (field.stored) uiAttr(input, "placeholder", "providers.secret-stored");
  } else if (field.value !== null) {
    input.value = String(field.value);
  }
  return input;
}

/**
 * A blank secret means "keep what is stored", and a blank text field means the
 * same, so saving a partly filled form never erases credentials by accident.
 */
function fieldValue(field: ProviderFieldView, control: HTMLInputElement | HTMLSelectElement | null): unknown {
  if (control === null) return undefined;
  if (field.kind === "boolean") return control instanceof HTMLInputElement ? control.checked : false;
  const text = control.value.trim();
  if (text.length === 0) return undefined;
  if (field.kind === "number") {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return text;
}

export function createProvidersPane(): ProvidersPane {
  const panel = createSidebarPanel("tune", "library.providers");
  uiAttr(panel.navigation, "aria-label", "library.providers");
  panel.toolbar.innerHTML = `<span class="code-location" data-provider-heading>${uiLabel("library.providers")}</span>
    <button type="button" class="library-refresh" data-provider-refresh ${uiAttribute("aria-label", "common.refresh")} ${uiAttribute("title", "common.refresh")}>${icon("refresh")}</button>`;
  panel.content.innerHTML = `<div class="media-status" data-provider-status role="status" hidden></div>
    <div class="provider-page">
      <div class="provider-groups" data-provider-groups></div>
      <div class="provider-actions">
        <button type="button" data-provider-save data-primary>${uiLabel("common.save")}</button>
        <button type="button" data-provider-check-gateway>${uiLabel("providers.check-gateway")}</button>
        <button type="button" data-provider-pull>${uiLabel("providers.pull")}</button>
        <button type="button" data-provider-reload>${uiLabel("providers.reload")}</button>
      </div>
      <p class="provider-note" data-provider-path></p>
      <p class="provider-note" data-provider-remote></p>
      <p class="provider-note" data-provider-secrets-note></p>
    </div>`;
  const groupsNode = panel.content.querySelector<HTMLElement>("[data-provider-groups]")!;
  const status = panel.content.querySelector<HTMLElement>("[data-provider-status]")!;
  const pathNote = panel.content.querySelector<HTMLElement>("[data-provider-path]")!;
  const remoteNote = panel.content.querySelector<HTMLElement>("[data-provider-remote]")!;
  const secretsNote = panel.content.querySelector<HTMLElement>("[data-provider-secrets-note]")!;
  const save = panel.content.querySelector<HTMLButtonElement>("[data-provider-save]")!;
  const checkGateway = panel.content.querySelector<HTMLButtonElement>("[data-provider-check-gateway]")!;
  const pull = panel.content.querySelector<HTMLButtonElement>("[data-provider-pull]")!;
  const reload = panel.content.querySelector<HTMLButtonElement>("[data-provider-reload]")!;
  const refresh = panel.toolbar.querySelector<HTMLButtonElement>("[data-provider-refresh]")!;
  let view: ProviderSettingsView | null = null;
  let loaded = false;
  let busy = false;

  const setGatewayVisibility = (enabled: boolean): void => {
    groupsNode.querySelectorAll<HTMLElement>("[data-provider-group]").forEach((section) => {
      section.hidden = enabled && section.dataset.providerGroup !== "hypit_gateway";
    });
    checkGateway.hidden = !enabled;
    pull.hidden = enabled;
    reload.hidden = enabled;
    pathNote.hidden = enabled;
    remoteNote.hidden = enabled;
    uiText(secretsNote, enabled ? "providers.gateway-secrets-note" : "providers.secrets-note");
  };

  const say = (message?: string, tone: "note" | "error" = "note"): void => {
    status.hidden = message === undefined;
    status.textContent = message ?? "";
    status.style.color = tone === "error" ? "" : "var(--text-3)";
  };

  const render = (next: ProviderSettingsView): void => {
    view = next;
    groupsNode.replaceChildren();
    for (const group of next.groups) {
      const section = document.createElement("section");
      section.className = "provider-group";
      section.dataset.providerGroup = group.id;
      const header = document.createElement("header");
      header.innerHTML = uiLabel(group.label as Message);
      const fields = document.createElement("div");
      fields.className = "provider-fields";
      for (const field of group.fields) {
        const row = document.createElement("label");
        row.className = "provider-field";
        row.dataset.providerGroup = group.id;
        row.dataset.providerKey = field.key;
        const caption = document.createElement("span");
        caption.className = "provider-field-caption";
        caption.innerHTML = uiLabel(field.label as Message);
        row.append(caption, fieldControl(field));
        fields.append(row);
      }
      section.append(header, fields);
      groupsNode.append(section);
    }
    const gatewayGroup = next.groups.find((group) => group.id === "hypit_gateway");
    const gatewayEnabled = gatewayGroup?.fields.find((field) => field.key === "enabled")?.value === true;
    setGatewayVisibility(gatewayEnabled);
    uiText(pathNote, "providers.path", { path: next.path });
    if (next.remote.configured) {
      uiText(remoteNote, "providers.remote", { url: next.remote.url ?? "", state: next.remote.error ?? (next.remote.pulledAt ?? "") });
    } else {
      uiText(remoteNote, "providers.remote-none");
    }
    save.disabled = false;
    checkGateway.disabled = false;
    pull.disabled = !next.remote.configured;
    reload.disabled = false;
  };

  const request = async (method: "GET" | "PUT" | "POST", value?: unknown): Promise<ProviderSettingsView> => {
    const suffix = method === "POST" ? "/pull" : "";
    const response = await fetch(`/__studio/provider-settings${suffix}`, method === "GET"
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value ?? {}) });
    const body = await response.json() as ProviderSettingsView & { error?: string };
    if (!response.ok || typeof body.error === "string") throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  };

  const load = async (): Promise<void> => {
    busy = true;
    say(t("providers.loading"));
    try {
      render(await request("GET"));
      loaded = true;
      say();
    } catch (error) {
      say(t("providers.load-failed", { detail: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      busy = false;
    }
  };

  const submit = async (): Promise<boolean> => {
    if (view === null || busy) return false;
    const patch: Record<string, Record<string, unknown>> = {};
    for (const group of view.groups) {
      const fields: Record<string, unknown> = {};
      for (const field of group.fields) {
        const node = groupsNode.querySelector<HTMLElement>(fieldSelector(group.id, field.key));
        const control = node?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select") ?? null;
        const value = fieldValue(field, control);
        if (value !== undefined) fields[field.key] = value;
      }
      if (Object.keys(fields).length > 0) patch[group.id] = fields;
    }
    busy = true;
    save.disabled = true;
    say(t("common.saving"));
    try {
      render(await request("PUT", patch));
      say(t("providers.saved"));
      return true;
    } catch (error) {
      save.disabled = false;
      say(t("providers.save-failed", { detail: error instanceof Error ? error.message : String(error) }), "error");
      return false;
    } finally {
      busy = false;
    }
  };

  const verifyGateway = async (): Promise<void> => {
    if (busy || !(await submit())) return;
    busy = true;
    checkGateway.disabled = true;
    say(t("providers.checking-gateway"));
    try {
      const response = await fetch("/__studio/provider-settings/gateway-check", { method: "POST" });
      const body = await response.json() as GatewayCheckView & { error?: string };
      if (!response.ok || typeof body.error === "string") {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }
      const available = body.wallet.availableFen ?? body.wallet.balanceFen;
      say(t("providers.gateway-ok", {
        tenant: body.tenant.name ?? body.tenant.id ?? "unknown",
        balance: available === null ? "?" : (available / 100).toFixed(2),
        voices: body.voiceCount,
      }));
    } catch (error) {
      say(t("providers.gateway-failed", {
        detail: error instanceof Error ? error.message : String(error),
      }), "error");
    } finally {
      busy = false;
      checkGateway.disabled = false;
    }
  };

  const sync = async (): Promise<void> => {
    if (busy || view === null || !view.remote.configured) return;
    busy = true;
    pull.disabled = true;
    say(t("providers.pulling"));
    try {
      const next = await request("POST");
      const applied = next.applied ?? [];
      const refused = next.refusedSecrets ?? [];
      render(next);
      if (refused.length > 0) say(t("providers.pull-refused", { count: refused.length, fields: refused.join(", ") }), "error");
      else say(applied.length === 0 ? t("providers.pull-none") : t("providers.pull-applied", { groups: applied.join(", ") }));
    } catch (error) {
      say(t("providers.pull-failed", { detail: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      busy = false;
      if (view !== null) pull.disabled = !view.remote.configured;
    }
  };

  save.addEventListener("click", () => { void submit(); });
  checkGateway.addEventListener("click", () => { void verifyGateway(); });
  pull.addEventListener("click", () => { void sync(); });
  reload.addEventListener("click", () => { void load(); });
  refresh.addEventListener("click", () => { void load(); });
  groupsNode.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    if (target.dataset.providerGroup !== "hypit_gateway" || target.dataset.providerKey !== "enabled") return;
    setGatewayVisibility(target.checked);
  });
  panel.content.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void submit();
    }
  });

  return {
    element: panel.element,
    activate() {
      if (!loaded) void load();
    },
  };
}

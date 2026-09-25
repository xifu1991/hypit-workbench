import { readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  assertAttributes,
  canonicalize,
  createMarkupSurfaceHostFacet,
  sameType,
  sealGraphFragment,
  textAttribute,
} from "@hypit/hypit/author-kit";
import type {
  ComponentPackage,
  FragmentOperation,
  ModuleManifest,
  StructuredSurfaceHandler,
  SurfaceResolvedReference,
  TypeRef,
} from "@hypit/hypit/author-kit";
import { compositionTypes } from "@hypit/hypit/composition";
import { timelineTypes } from "@hypit/hypit/timeline";
import { spatialTypes } from "@hypit/hypit/spatial";
import { temporalTypes } from "@hypit/hypit/temporal";
import type { Timeline } from "@hypit/hypit/timeline";
import type { CanvasSpace } from "@hypit/hypit/spatial";
import type { TemporalWindow } from "@hypit/hypit/temporal";
import {
  createTemporalWindowProjection,
  resolveTemporalContext,
  temporalContextAttributeVocabulary,
  temporalWindowAttributeNames,
  temporalWindowAttributeVocabulary,
} from "@hypit/hypit/temporal-markup";
import { renderStyleBoard } from "./render.js";
import type { BoardImages, BoardOptions } from "./render.js";

const module = { name: "@example/style-board", version: "1" } as const;
const types = Object.fromEntries(["Options", "Images"].map(name => [name, { module, name }])) as Record<"Options" | "Images", TypeRef>;
const producers = Object.fromEntries(["render"].map(name => [name, { module, name }])) as Record<"render", { module: typeof module; name: string }>;

export const manifest: ModuleManifest = {
  format: "hypit.module@1",
  ...module,
  dependencies: [compositionTypes.visualTrack, timelineTypes.track, spatialTypes.canvas, temporalTypes.window].map(type => ({ module: type.module })),
  types: Object.values(types).map(type => ({ name: type.name })),
  capabilities: [],
  producers: [{
    name: "render",
    inputs: [
      { name: "images", type: types.Images },
      { name: "options", type: types.Options },
      { name: "timeline", type: timelineTypes.track },
      { name: "canvas", type: spatialTypes.canvas },
      { name: "window", type: temporalTypes.window },
    ],
    outputs: [{ name: "track", type: compositionTypes.visualTrack }],
    needs: [],
  }],
};

const value = (data: unknown) => ({ kind: "inline" as const, value: canonicalize(data) });
const inline = <T>(record: { value: { kind: string; value?: unknown } } | undefined): T => {
  if (record?.value.kind !== "inline") throw new Error("Style Board inputs must be inline values.");
  return record.value.value as T;
};

function mimeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function dataUrl(file: string): string {
  const bytes = readFileSync(file);
  return `data:${mimeFor(file)};base64,${bytes.toString("base64")}`;
}

const component: ComponentPackage = {
  producers: [{
    producer: producers.render,
    handler: ({ inputs }) => ({
      outputs: {
        track: value(renderStyleBoard(
          inline<Timeline>(inputs.timeline),
          inline<CanvasSpace>(inputs.canvas),
          inline<TemporalWindow>(inputs.window),
          inline<BoardImages>(inputs.images),
          inline<BoardOptions>(inputs.options),
        )),
      },
      needs: {},
    }),
  }],
};

export const decodeSurface: StructuredSurfaceHandler = ({ element, resolveReference }) => {
  assertAttributes(element, [
    "id", "timeline", "canvas", "title", "subtitle",
    "open", "product", "face", "circle", "notes", "final", "video",
    ...temporalWindowAttributeNames,
  ]);
  const id = textAttribute(element, "id");
  const context = resolveTemporalContext({ element, resolveReference });
  const window = createTemporalWindowProjection({ id: `${id}.window`, subjectId: id, element, ...context, resolveReference });
  const reference = (name: string, type: TypeRef): SurfaceResolvedReference => {
    const raw = element.attributes[name];
    if (typeof raw !== "object" || raw.kind !== "reference") throw new Error(`${name} must be a reference.`);
    const found = resolveReference(raw.path);
    if (found === undefined || !sameType(found.type, type)) throw new Error(`${name} has the wrong Type.`);
    return found;
  };
  const options: BoardOptions = { id, title: textAttribute(element, "title"), subtitle: textAttribute(element, "subtitle") };
  const images: BoardImages = {
    open: dataUrl(textAttribute(element, "open")),
    product: dataUrl(textAttribute(element, "product")),
    face: dataUrl(textAttribute(element, "face")),
    circle: dataUrl(textAttribute(element, "circle")),
    notes: dataUrl(textAttribute(element, "notes")),
    final: dataUrl(textAttribute(element, "final")),
    video: element.attributes.video ? dataUrl(textAttribute(element, "video")) : "",
  };
  const records = [
    ...window.records,
    { id: `${id}.options`, type: types.Options, value: value(options), range: element.range },
    { id: `${id}.images`, type: types.Images, value: value(images), range: element.range },
  ];
  const inputs = [
    { name: "images", type: types.Images },
    { name: "options", type: types.Options },
    { name: "timeline", type: timelineTypes.track },
    { name: "canvas", type: spatialTypes.canvas },
    { name: "window", type: temporalTypes.window },
  ];
  const operations: FragmentOperation[] = [{
    id: "render",
    producer: producers.render,
    inputs: {
      images: { kind: "fragment-input", name: "images" },
      options: { kind: "fragment-input", name: "options" },
      timeline: { kind: "fragment-input", name: "timeline" },
      canvas: { kind: "fragment-input", name: "canvas" },
      window: { kind: "fragment-input", name: "window" },
    },
    result: { kind: "output", name: "track" },
  }];
  const fragment = sealGraphFragment({ inputs, operations, exports: [{ name: "track", type: compositionTypes.visualTrack, root: { kind: "fragment-operation", operation: "render" } }] });
  return {
    records,
    fragments: [...window.fragments, fragment],
    components: [
      ...window.components,
      {
        id,
        fragment: fragment.id,
        inputs: {
          images: { kind: "record", id: `${id}.images` },
          options: { kind: "record", id: `${id}.options` },
          timeline: context.timeline.ref,
          canvas: reference("canvas", spatialTypes.canvas).ref,
          window: window.ref,
        },
        outputs: { track: `${id}.track` },
        range: element.range,
      },
    ],
    exports: [`${id}.track`],
  };
};

const declaration = {
  name: "style-board",
  tag: "Board",
  mode: "structured" as const,
  outputs: [compositionTypes.visualTrack, timelineTypes.track, temporalTypes.window, temporalTypes.instant, temporalTypes.windowSpec, temporalTypes.instantSpec, ...Object.values(types)],
  vocabulary: {
    summary: "A 20-second director board for cloning a Douyin product-seeding edit style.",
    attributes: [
      ...temporalContextAttributeVocabulary,
      ...temporalWindowAttributeVocabulary,
      ...["id", "title", "subtitle", "canvas", "open", "product", "face", "circle", "notes", "final", "video"].map(name => ({
        name,
        kind: "expression" as const,
        required: true,
        summary: name,
      })),
    ],
    children: [],
    ports: [{ name: "track", type: compositionTypes.visualTrack, summary: "The visible 20-second style board." }],
    example: '<style:Board id="board" timeline={animation.timeline} canvas={canvas} during="program" title="Style clone" subtitle="20s proof" open="/tmp/open.jpg" product="/tmp/product.jpg" face="/tmp/face.jpg" circle="/tmp/circle.jpg" notes="/tmp/notes.jpg" final="/tmp/final.jpg"/>',
  },
};

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  modules: [{ manifest }],
  components: [component],
  hostFacets: [createMarkupSurfaceHostFacet({ module, declaration, handler: decodeSurface })],
};

export default hypitPackage;

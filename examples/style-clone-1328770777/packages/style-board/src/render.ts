import { sealVisualTrack } from "@hypit/hypit/composition";
import { browserProgram } from "@hypit/hypit/hyperframes";
import type { Timeline } from "@hypit/hypit/timeline";
import type { CanvasSpace } from "@hypit/hypit/spatial";
import { assertTemporalWindowFor } from "@hypit/hypit/temporal";
import type { TemporalWindow } from "@hypit/hypit/temporal";

export type BoardImages = {
  open: string;
  product: string;
  face: string;
  circle: string;
  notes: string;
  final: string;
  video: string;
};

export type BoardOptions = {
  id: string;
  title: string;
  subtitle: string;
};

type Scene = {
  id: string;
  start: number;
  end: number;
  image: keyof BoardImages;
  title: string;
  subtitle: string;
  caption: string;
  layout: "hook" | "product" | "face" | "circle" | "notes" | "final";
};

const scenes: readonly Scene[] = [
  { id: "hook", start: 0, end: 90, image: "open", title: "先看这一点", subtitle: "很多人第一步就做错了", caption: "明亮人物近景开场，直接进入种草语境", layout: "hook" },
  { id: "product", start: 90, end: 240, image: "product", title: "先闻这一瓶", subtitle: "画面跟着动作切换", caption: "产品近景与主播动作交替出现", layout: "product" },
  { id: "face", start: 240, end: 390, image: "face", title: "它的感觉是", subtitle: "清透、柔和、很有画面感", caption: "回到主播解释真实使用感", layout: "face" },
  { id: "circle", start: 390, end: 540, image: "circle", title: "把信息讲清楚", subtitle: "不堆花字，只保留关键点", caption: "用轻信息卡承接知识点", layout: "circle" },
  { id: "notes", start: 540, end: 720, image: "notes", title: "香调展开", subtitle: "前调 / 中调 / 后调", caption: "插入图示或截图，增强可信度", layout: "notes" },
  { id: "final", start: 720, end: 900, image: "final", title: "最后的选择", subtitle: "适合日常，也适合送人", caption: "自然收尾，保留轻量 CTA", layout: "final" },
];

function programFor(scene: Scene, image: string, canvas: CanvasSpace, video?: string) {
  const layoutClass = `layout-${scene.layout}`;
  const html = `<div class="stage ${layoutClass}${video ? " video-mode" : ""}">
    ${video ? `<video class="video" src="${video}" muted playsinline preload="auto"></video>` : `<img class="bg" src="${image}" />`}
    <div class="shade"></div>
    <div class="portrait"><img src="${image}" /></div>
    <div class="circle"><img src="${image}" /></div>
    <div class="word word-a">约会</div><div class="word word-b">通勤</div>
    <div class="word word-c">温柔</div><div class="word word-d">氛围</div>
    <div class="copy"><div class="title">${scene.title}</div><div class="subtitle">${scene.subtitle}</div></div>
    <div class="note-list"><b>果香开场</b><b>玫瑰牡丹</b><b>香草收尾</b></div>
    <div class="caption">${scene.caption}</div>
  </div>`;
  const css = `:scope{overflow:hidden;background:#f7f3ec;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#2f2a26}
    .stage{position:absolute;inset:0;overflow:hidden;background:#f7f3ec}.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#f7f3ec}
    .video-mode .portrait,.video-mode .circle{display:none!important}
    .shade{position:absolute;inset:0;background:rgba(255,255,255,.08)}.copy{position:absolute;left:34px;right:34px;top:54px;text-align:center;z-index:5}
    .title{font-size:49px;line-height:1.06;font-weight:900;color:#2f2a26;text-shadow:0 2px 0 rgba(255,255,255,.7)}
    .subtitle{margin-top:10px;font-size:34px;line-height:1.18;font-weight:800;color:#4d433b}
    .caption{position:absolute;left:36px;right:36px;bottom:92px;text-align:center;font-size:29px;font-weight:900;color:#fff;background:rgba(45,37,31,.72);padding:9px 14px;border-radius:8px;z-index:6}
    .portrait,.circle,.word,.note-list{position:absolute;z-index:4}.portrait{display:none;border:7px solid #fff;border-radius:24px;overflow:hidden;box-shadow:0 12px 0 rgba(0,0,0,.45)}
    .portrait img,.circle img{width:100%;height:100%;object-fit:cover}.circle{display:none;border:9px solid #fff;border-radius:50%;overflow:hidden;box-shadow:0 12px 0 rgba(0,0,0,.65)}
    .word{display:none;font-size:34px;font-weight:900;color:#5a4b42}.note-list{display:none;left:62px;top:242px;gap:24px;flex-direction:column}
    .note-list b{font-size:42px;line-height:1.2;color:#5a4b42}.layout-hook .bg{display:block;filter:saturate(.9) brightness(1.08)}
    .layout-hook .portrait{display:block;left:84px;top:240px;width:552px;height:760px;border:0;box-shadow:none}.layout-hook .copy{top:68px}
    .layout-hook .title{font-size:44px}.layout-hook .subtitle{font-size:34px}.layout-product .bg{transform:scale(1.16);filter:saturate(1.04) contrast(1.03)}
    .layout-product .shade{background:rgba(255,255,255,.05)}.layout-product .copy{text-align:left;top:64px}.layout-product .title{font-size:48px}
    .layout-product .subtitle{font-size:35px}.layout-product .circle{display:none}.layout-face .bg{transform:scale(1.08)}
    .layout-face .shade{background:linear-gradient(rgba(255,255,255,.08),rgba(255,255,255,0) 27%,rgba(0,0,0,.08))}.layout-face .copy{top:48px}
    .layout-circle .bg{display:block;filter:brightness(1.06)}.layout-circle .circle{display:none}.layout-circle .copy{top:84px}
    .layout-circle .title{font-size:48px}.layout-circle .subtitle{font-size:35px}.layout-circle .word{display:none}
    .layout-notes .bg{transform:scale(1.1);filter:brightness(1.08)}.layout-notes .shade{background:rgba(255,255,255,.12)}.layout-notes .copy{text-align:left;top:58px}.layout-notes .note-list{display:flex}
    .layout-notes .portrait{display:block;right:44px;bottom:203px;width:210px;height:342px;border:6px solid #fff;box-shadow:0 8px 20px rgba(80,60,40,.2)}.layout-final .bg{transform:scale(1.08)}.layout-final .shade{background:linear-gradient(rgba(255,255,255,.08),rgba(255,255,255,0) 28%,rgba(0,0,0,.12))}
    .layout-final .copy{top:54px}.layout-final .title{color:#3c3029}.layout-final .subtitle{font-size:35px}`;
  return browserProgram({
    html,
    css,
    data: {},
    setup: `const stage=root.querySelector('.stage');const video=root.querySelector('.video');if(video){video.pause();}return frame=>{const p=Math.min(1,frame/14);stage.style.opacity=String(p);stage.style.transform='scale('+(1.012-0.012*p)+')';if(video&&video.readyState>=2){video.currentTime=Math.min(video.duration||20,frame/30);}};`,
  });
}

export function renderStyleBoard(timeline: Timeline, canvas: CanvasSpace, window: TemporalWindow, images: BoardImages, options: BoardOptions) {
  assertTemporalWindowFor(window, { subjectId: options.id, space: timeline });
  const start = window.span.startFrame;
  const end = window.span.endFrameExclusive;
  const activeScenes = scenes
    .map((scene) => ({
      ...scene,
      start: Math.min(start + scene.start, end),
      end: Math.min(start + scene.end, end),
    }))
    .filter((scene) => scene.end > scene.start);
  return sealVisualTrack({
    id: options.id,
    programSpaceId: timeline.id,
    visualIr: "hypit.visual-ir@1",
    presents: activeScenes.map((scene, index) => ({
      id: scene.id,
      span: { startFrame: scene.start, endFrameExclusive: scene.end },
      stacking: { order: index, tieBreak: scene.id },
      elements: [{
        id: `${scene.id}.program`,
        kind: "program",
        order: 0,
        program: programFor(scene, images[scene.image], canvas, images.video),
        style: [
          { name: "position", value: "absolute" },
          { name: "inset", value: 0 },
          { name: "width", value: `${canvas.widthPx}px` },
          { name: "height", value: `${canvas.heightPx}px` },
        ],
      }],
    })),
  });
}

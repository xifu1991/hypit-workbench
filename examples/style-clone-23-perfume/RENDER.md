# 渲染与验收记录

## 工程

- 画面：`picture:Track` 31 个 Item（13 个完整人物 + 18 个中近景推入），推入镜头用 `<Sampling>` 关键帧实现取景与轻推近。
- 声音：`audio:Track` 25 个 Item，覆盖 0–3266 帧，保留主播原声。
- 花字：`keywords` 独立轨，25 条，只提炼产品名与香调结论。
- 字幕：`captions` 独立轨，12 条，只出现在中近景段落，替代被裁掉的原片烧录字幕。

## 构建

- 成功构建：`bld_20260924T015608647Z_0AF5E3FD07`（本地 media / hyperframes 端点，无 Provider 费用）。
- 成片：`outputs/23_perfume_style/23_perfume_style_final.mp4`。
- 规格：720x1280、30fps、3266 帧、108.867s、H.264 + AAC 立体声。
- 音频实测 mean -13.5 dB / max 0.0 dB，与源片口播一致，不是静音底片。

## 首版被否与修正

首版（`qa/v1_rejected.mp4`）有两个问题：产品近景裁切过紧，把人物头部切在眼睛处；
原片烧录字幕位于画面 76%–84% 高度，2.0 倍裁切把它放大进画面，与工程字幕叠加成两层文字。

修正：实测源帧坐标后，把推入镜头固定在取景中心 y=0.405→0.39、倍率 1.50→1.60，
使画面同时保留头顶并排除烧录字幕；工程字幕只在这些段落出现。

## 环境注意

HyperFrames 的源帧解码使用引擎自带解析器，需要 `ffprobe`。渲染前须把 ffmpeg 目录加入 PATH，
或设置 `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH`，否则构建会在
“decoding source frames” 处报 `FFprobe is unavailable`。

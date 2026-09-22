export type BitmapCue = {
  start: number; end: number; x: number; y: number; width: number; height: number;
  canvasWidth: number; canvasHeight: number; url: string;
};

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function bitmapPaintPlan(cues: BitmapCue[], fallbackCanvas = { width: 0, height: 0 }) {
  const canvasWidth = Math.max(1, finite(fallbackCanvas.width), ...cues.map(cue => finite(cue.canvasWidth)));
  const canvasHeight = Math.max(1, finite(fallbackCanvas.height), ...cues.map(cue => finite(cue.canvasHeight)));
  return {
    canvasWidth,
    canvasHeight,
    pictures: cues.map(cue => {
      const x = Math.max(0, finite(cue.x)), y = Math.max(0, finite(cue.y));
      return { url: cue.url, x, y, width: Math.max(0, Math.min(finite(cue.width), canvasWidth - x)),
        height: Math.max(0, Math.min(finite(cue.height), canvasHeight - y)) };
    }).filter(picture => picture.width > 0 && picture.height > 0),
  };
}

export function assRendererFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || "");
  return /content.security.policy|\bcsp\b|wasm-unsafe-eval|unsafe-eval/i.test(detail)
    ? "浏览器安全策略阻止了 ASS 特效渲染器"
    : "ASS 特效渲染器启动失败";
}

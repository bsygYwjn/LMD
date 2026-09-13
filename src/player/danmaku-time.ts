export type Anchor = { source: number; target: number };
export type Exclude = { from: number; to: number };

/** Maps a provider timestamp onto the original video timeline. */
export function mappedTime(time: number, anchors: Anchor[], delay: number) {
  if (!anchors.length) return time + delay;
  // Each anchor starts a new offset interval. Before the first anchor the
  // provider timeline is used unchanged: the anchor describes a correction that
  // begins at that point, and applying it backwards would move earlier comments
  // by an offset the user never specified.
  let low = 0;
  while (low + 1 < anchors.length && anchors[low + 1].source <= time) low++;
  const anchor = anchors[low];
  if (time < anchor.source) return time + delay;
  return time + anchor.target - anchor.source + delay;
}

/**
 * Full time mapping for one comment.
 *
 * Three layers exist and must never be applied twice: the provider may already
 * have calibrated its own timeline, the media version stores at most one
 * mapping, and the viewer adds a local delay. This function applies only the
 * latter two, and returns null when the comment sits inside an interval that
 * was removed from this copy of the video.
 */
export function applyMapping(time: number, options: { anchors?: Anchor[]; excludes?: Exclude[]; delay?: number } = {}): number | null {
  for (const range of options.excludes || []) if (time >= range.from && time < range.to) return null;
  return mappedTime(time, options.anchors || [], options.delay || 0);
}

export function validateAnchors(anchors: Anchor[]) {
  if (anchors.length > 50) return "校准点最多 50 个";
  for (let index = 0; index < anchors.length; index++) {
    if (index > 0 && anchors[index].source <= anchors[index - 1].source) return "来源时间必须递增";
    // A later anchor must not move comments backwards past the previous one,
    // otherwise the offsets overlap and comments would be reordered.
    if (index > 0 && anchors[index].target < anchors[index - 1].target) return "视频时间不能小于上一个校准点";
  }
  return "";
}

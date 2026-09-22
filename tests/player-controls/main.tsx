import React from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer } from "../../src/player/Player";
const media = { id: "fixture", title: "控件隔离测试", fileName: "fixture.mp4", extension: "MP4", size: 1, subtitles: [], fonts: [], posterHue: 0 };
window.nextCount = 0;
createRoot(document.getElementById("root")!).render(<VideoPlayer media={media} pageMode nextMedia={{ ...media, id: "next" }} onNext={() => window.nextCount++} />);

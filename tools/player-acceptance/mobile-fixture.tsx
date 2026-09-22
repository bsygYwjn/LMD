// Isolated browser fixture: real player/core, local test MP4, stub session API.
import React from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer } from "../../src/player/Player";
import "../../src/styles.css";

const media = { id: "mobile-fixture", title: "移动端布局验收", fileName: "sample.mp4", extension: "MP4", size: 1, subtitles: [], fonts: [], posterHue: 180 };
createRoot(document.getElementById("root")!).render(<React.StrictMode><div style={{ padding: 12, maxWidth: 1180, margin: "auto" }}><VideoPlayer media={media} pageMode nextMedia={{ ...media, id: "next" }} /></div></React.StrictMode>);

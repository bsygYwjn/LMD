import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";

const [, , viewingUrl, outputPath] = process.argv;

if (!viewingUrl || !outputPath) {
  console.error("用法：node tray-qr.mjs <观看地址> <PNG 输出路径>");
  process.exit(1);
}

const dataUrl = await QRCode.toDataURL(viewingUrl, {
  type: "image/png",
  width: 300,
  margin: 2,
  errorCorrectionLevel: "M",
  color: { dark: "#14233C", light: "#FFFFFFFF" },
});

await writeFile(outputPath, Buffer.from(dataUrl.split(",")[1], "base64"));

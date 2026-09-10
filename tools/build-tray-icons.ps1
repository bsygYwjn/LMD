param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$brandDirectory = Join-Path $projectDirectory 'assets\brand'
$publicBrandDirectory = Join-Path $projectDirectory 'public\brand'
$sourcePath = Join-Path $brandDirectory 'lmd-mark.svg'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.Directory]::CreateDirectory($publicBrandDirectory) | Out-Null

# The editable SVG is the single geometry source for web, Windows and documentation.
$source = [System.IO.File]::ReadAllText($sourcePath)
[xml]$document = $source
$group = $document.SelectSingleNode('//*[local-name()="g"]')
$paths = @($group.SelectNodes('*[local-name()="path"]') | ForEach-Object { $_.GetAttribute('d') })
if ($document.DocumentElement.GetAttribute('viewBox') -ne '0 0 64 64' -or $paths.Count -ne 2) {
  throw 'Expected the LMD 64-unit master SVG with two paths.'
}
$brandColor = $group.GetAttribute('stroke')
$strokeWidth = [single]::Parse($group.GetAttribute('stroke-width'), [Globalization.CultureInfo]::InvariantCulture)
$iconSvg = $source.Replace('<title>LMD</title>', '<title>LMD</title><rect width="64" height="64" rx="14" fill="' + $brandColor + '"/>').Replace('stroke="' + $brandColor + '"', 'stroke="#FFFFFF"')
[System.IO.File]::WriteAllText((Join-Path $brandDirectory 'lmd-icon.svg'), $iconSvg, $utf8)
[System.IO.File]::WriteAllText((Join-Path $brandDirectory 'lmd-mono.svg'), $source.Replace($brandColor, '#172033'), $utf8)
[System.IO.File]::WriteAllText((Join-Path $brandDirectory 'lmd-inverse.svg'), $source.Replace($brandColor, '#FFFFFF'), $utf8)
foreach ($name in @('lmd-mark.svg', 'lmd-icon.svg', 'lmd-mono.svg', 'lmd-inverse.svg')) {
  Copy-Item -LiteralPath (Join-Path $brandDirectory $name) -Destination (Join-Path $publicBrandDirectory $name) -Force
}

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

public static class LmdBrandRenderer {
    private static float Number(string token) { return float.Parse(token, CultureInfo.InvariantCulture); }

    // Deliberately small SVG subset: fail on unsupported edits instead of drawing a different logo.
    private static GraphicsPath ReadPath(string data) {
        var tokens = Regex.Matches(data, @"[A-Za-z]|-?\d+(?:\.\d+)?");
        var path = new GraphicsPath();
        var current = new PointF();
        int index = 0;
        while (index < tokens.Count) {
            string command = tokens[index++].Value;
            if (command == "M" || command == "L") {
                var next = new PointF(Number(tokens[index++].Value), Number(tokens[index++].Value));
                if (command == "M") path.StartFigure();
                else path.AddLine(current, next);
                current = next;
            } else if (command == "Q") {
                var control = new PointF(Number(tokens[index++].Value), Number(tokens[index++].Value));
                var next = new PointF(Number(tokens[index++].Value), Number(tokens[index++].Value));
                path.AddBezier(current,
                    new PointF(current.X + (control.X - current.X) * 2 / 3, current.Y + (control.Y - current.Y) * 2 / 3),
                    new PointF(next.X + (control.X - next.X) * 2 / 3, next.Y + (control.Y - next.Y) * 2 / 3), next);
                current = next;
            } else { path.Dispose(); throw new InvalidOperationException("Unsupported SVG command: " + command); }
        }
        return path;
    }

    public static byte[] Render(string[] paths, float width, string foreground, string background, int size) {
        // Supersampling preserves the open spaces and rounded ends at 16 / 20 / 24 px.
        int renderSize = size * 4;
        using (var high = new Bitmap(renderSize, renderSize, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(high)) {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.ScaleTransform(renderSize / 64f, renderSize / 64f);
            if (!String.IsNullOrEmpty(background)) {
                using (var tile = new GraphicsPath())
                using (var brush = new SolidBrush(ColorTranslator.FromHtml(background))) {
                    tile.AddArc(0, 0, 28, 28, 180, 90);
                    tile.AddArc(36, 0, 28, 28, 270, 90);
                    tile.AddArc(36, 36, 28, 28, 0, 90);
                    tile.AddArc(0, 36, 28, 28, 90, 90);
                    tile.CloseFigure();
                    graphics.FillPath(brush, tile);
                }
            }
            using (var pen = new Pen(ColorTranslator.FromHtml(foreground), width)) {
                pen.StartCap = pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                foreach (var data in paths) {
                    using (var path = ReadPath(data)) graphics.DrawPath(pen, path);
                }
            }
            using (var output = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (var scaled = Graphics.FromImage(output))
            using (var attributes = new ImageAttributes())
            using (var stream = new MemoryStream()) {
                scaled.CompositingMode = CompositingMode.SourceCopy;
                scaled.InterpolationMode = InterpolationMode.HighQualityBicubic;
                scaled.PixelOffsetMode = PixelOffsetMode.HighQuality;
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                scaled.DrawImage(high, new Rectangle(0, 0, size, size), 0, 0, renderSize, renderSize, GraphicsUnit.Pixel, attributes);
                output.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }
    }
}
"@

function Write-BrandPng([string]$Destination, [int]$Size, [string]$Foreground = '#FFFFFF', [string]$Background = $brandColor) {
  [System.IO.File]::WriteAllBytes($Destination, [LmdBrandRenderer]::Render($paths, $strokeWidth, $Foreground, $Background, $Size))
}

function Write-BrandIcon([string]$Destination, [string]$Background = $brandColor) {
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $images = New-Object 'System.Collections.Generic.List[byte[]]'
  foreach ($size in $sizes) { $images.Add([LmdBrandRenderer]::Render($paths, $strokeWidth, '#FFFFFF', $Background, $size)) }
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$index].Length
    }
    foreach ($image in $images) { $writer.Write($image) }
    [System.IO.File]::WriteAllBytes($Destination, $stream.ToArray())
  } finally { $writer.Dispose(); $stream.Dispose() }
}

Write-BrandPng (Join-Path $brandDirectory 'lmd-icon.png') 512
Write-BrandPng (Join-Path $brandDirectory 'lmd-mark.png') 512 $brandColor ''
Write-BrandPng (Join-Path $projectDirectory 'assets\tray-running.png') 256
Write-BrandPng (Join-Path $projectDirectory 'assets\tray-stopped.png') 256 '#FFFFFF' '#687386'
Write-BrandIcon (Join-Path $projectDirectory 'assets\tray-running.ico')
Write-BrandIcon (Join-Path $projectDirectory 'assets\tray-stopped.ico') '#687386'
Copy-Item -LiteralPath (Join-Path $projectDirectory 'assets\tray-running.ico') -Destination (Join-Path $brandDirectory 'lmd.ico') -Force
Copy-Item -LiteralPath (Join-Path $brandDirectory 'lmd.ico') -Destination (Join-Path $projectDirectory 'public\favicon.ico') -Force
Write-BrandPng (Join-Path $publicBrandDirectory 'apple-touch-icon.png') 180
Write-BrandPng (Join-Path $publicBrandDirectory 'icon-192.png') 192
Write-BrandPng (Join-Path $publicBrandDirectory 'icon-512.png') 512
Write-Host 'LMD brand assets generated from assets/brand/lmd-mark.svg.'

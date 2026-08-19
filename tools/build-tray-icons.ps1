param(
  [string]$RunningSource,
  [string]$StoppedSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $PSScriptRoot
if (-not $RunningSource) { $RunningSource = Join-Path $projectDirectory "assets\icon-source\tray-running-selected.png" }
if (-not $StoppedSource) { $StoppedSource = Join-Path $projectDirectory "assets\icon-source\tray-stopped-selected.png" }

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class LvdTrayIconRenderer
{
    private static double Luma(byte red, byte green, byte blue)
    {
        return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    }

    public static Bitmap ExtractForeground(string sourcePath)
    {
        using (var loaded = new Bitmap(sourcePath))
        using (var source = new Bitmap(loaded.Width, loaded.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(source))
            {
                graphics.DrawImageUnscaled(loaded, 0, 0);
            }

            var rectangle = new Rectangle(0, 0, source.Width, source.Height);
            var sourceData = source.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var sourceBytes = new byte[Math.Abs(sourceData.Stride) * source.Height];
            Marshal.Copy(sourceData.Scan0, sourceBytes, 0, sourceBytes.Length);
            source.UnlockBits(sourceData);

            int sampleSize = Math.Max(4, Math.Min(source.Width, source.Height) / 64);
            long backgroundRed = 0, backgroundGreen = 0, backgroundBlue = 0, backgroundSamples = 0;
            long foregroundRed = 0, foregroundGreen = 0, foregroundBlue = 0, foregroundSamples = 0;

            for (int y = 0; y < source.Height; y++)
            {
                for (int x = 0; x < source.Width; x++)
                {
                    int index = y * sourceData.Stride + x * 4;
                    byte blue = sourceBytes[index];
                    byte green = sourceBytes[index + 1];
                    byte red = sourceBytes[index + 2];

                    bool corner = (x < sampleSize || x >= source.Width - sampleSize) &&
                                  (y < sampleSize || y >= source.Height - sampleSize);
                    if (corner)
                    {
                        backgroundRed += red;
                        backgroundGreen += green;
                        backgroundBlue += blue;
                        backgroundSamples++;
                    }

                    if (Luma(red, green, blue) < 85)
                    {
                        foregroundRed += red;
                        foregroundGreen += green;
                        foregroundBlue += blue;
                        foregroundSamples++;
                    }
                }
            }

            if (backgroundSamples == 0 || foregroundSamples == 0)
                throw new InvalidOperationException("Unable to detect icon foreground and background colors.");

            double bgR = (double)backgroundRed / backgroundSamples;
            double bgG = (double)backgroundGreen / backgroundSamples;
            double bgB = (double)backgroundBlue / backgroundSamples;
            double fgR = (double)foregroundRed / foregroundSamples;
            double fgG = (double)foregroundGreen / foregroundSamples;
            double fgB = (double)foregroundBlue / foregroundSamples;
            double vectorR = fgR - bgR;
            double vectorG = fgG - bgG;
            double vectorB = fgB - bgB;
            double vectorLength = vectorR * vectorR + vectorG * vectorG + vectorB * vectorB;

            var alpha = new byte[source.Width * source.Height];
            int minX = source.Width, minY = source.Height, maxX = -1, maxY = -1;
            for (int y = 0; y < source.Height; y++)
            {
                for (int x = 0; x < source.Width; x++)
                {
                    int sourceIndex = y * sourceData.Stride + x * 4;
                    double redDelta = sourceBytes[sourceIndex + 2] - bgR;
                    double greenDelta = sourceBytes[sourceIndex + 1] - bgG;
                    double blueDelta = sourceBytes[sourceIndex] - bgB;
                    double opacity = (redDelta * vectorR + greenDelta * vectorG + blueDelta * vectorB) / vectorLength;
                    opacity = Math.Max(0, Math.Min(1, opacity));
                    if (opacity < 0.025) opacity = 0;
                    else if (opacity > 0.975) opacity = 1;

                    byte alphaValue = (byte)Math.Round(opacity * 255);
                    alpha[y * source.Width + x] = alphaValue;
                    if (alphaValue > 10)
                    {
                        minX = Math.Min(minX, x);
                        minY = Math.Min(minY, y);
                        maxX = Math.Max(maxX, x);
                        maxY = Math.Max(maxY, y);
                    }
                }
            }

            if (maxX < minX || maxY < minY)
                throw new InvalidOperationException("No visible icon foreground was detected.");

            int contentWidth = maxX - minX + 1;
            int contentHeight = maxY - minY + 1;
            int padding = Math.Max(8, (int)Math.Ceiling(Math.Max(contentWidth, contentHeight) * 0.055));
            int canvasSize = Math.Max(contentWidth, contentHeight) + padding * 2;
            int offsetX = (canvasSize - contentWidth) / 2;
            int offsetY = (canvasSize - contentHeight) / 2;
            var result = new Bitmap(canvasSize, canvasSize, PixelFormat.Format32bppArgb);
            var resultRectangle = new Rectangle(0, 0, canvasSize, canvasSize);
            var resultData = result.LockBits(resultRectangle, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            var resultBytes = new byte[Math.Abs(resultData.Stride) * canvasSize];

            byte iconRed = (byte)Math.Round(fgR);
            byte iconGreen = (byte)Math.Round(fgG);
            byte iconBlue = (byte)Math.Round(fgB);
            for (int y = minY; y <= maxY; y++)
            {
                for (int x = minX; x <= maxX; x++)
                {
                    byte alphaValue = alpha[y * source.Width + x];
                    if (alphaValue == 0) continue;
                    int targetX = offsetX + x - minX;
                    int targetY = offsetY + y - minY;
                    int targetIndex = targetY * resultData.Stride + targetX * 4;
                    resultBytes[targetIndex] = iconBlue;
                    resultBytes[targetIndex + 1] = iconGreen;
                    resultBytes[targetIndex + 2] = iconRed;
                    resultBytes[targetIndex + 3] = alphaValue;
                }
            }

            Marshal.Copy(resultBytes, 0, resultData.Scan0, resultBytes.Length);
            result.UnlockBits(resultData);
            return result;
        }
    }

    public static byte[] RenderPng(Bitmap source, int size)
    {
        using (var output = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(output))
        using (var stream = new MemoryStream())
        {
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.DrawImage(source, new Rectangle(0, 0, size, size));
            output.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }
}
"@

function Write-MultiSizeIcon {
  param(
    [Parameter(Mandatory)] [System.Drawing.Bitmap]$Bitmap,
    [Parameter(Mandatory)] [string]$Destination
  )

  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $images = New-Object 'System.Collections.Generic.List[byte[]]'
  foreach ($size in $sizes) { $images.Add([LvdTrayIconRenderer]::RenderPng($Bitmap, $size)) }
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)

    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $size = $sizes[$index]
      $iconDimension = if ($size -eq 256) { 0 } else { $size }
      $writer.Write([byte]$iconDimension)
      $writer.Write([byte]$iconDimension)
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
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

function Build-TrayIcon {
  param(
    [Parameter(Mandatory)] [string]$Source,
    [Parameter(Mandatory)] [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Source)) { throw "Icon source not found: $Source" }
  $assetsDirectory = Join-Path $projectDirectory "assets"
  [System.IO.Directory]::CreateDirectory($assetsDirectory) | Out-Null
  $bitmap = [LvdTrayIconRenderer]::ExtractForeground($Source)
  try {
    $pngPath = Join-Path $assetsDirectory "$Name.png"
    $icoPath = Join-Path $assetsDirectory "$Name.ico"
    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-MultiSizeIcon -Bitmap $bitmap -Destination $icoPath
    [pscustomobject]@{ Name = $Name; Png = $pngPath; Icon = $icoPath }
  } finally {
    $bitmap.Dispose()
  }
}

Build-TrayIcon -Source $RunningSource -Name "tray-running"
Build-TrayIcon -Source $StoppedSource -Name "tray-stopped"

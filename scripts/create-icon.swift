import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("desktop/assets")
let iconset = root.appendingPathComponent("icon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let p = CGFloat(pixels)
        // Match public/boan-mark.svg in its 64 × 64, top-left-origin coordinates.
        // Original geometric shore + detached square: paths only, no font rendering.
        let transform = NSAffineTransform()
        transform.translateX(by: 0, yBy: p)
        transform.scaleX(by: p / 64, yBy: -p / 64)
        transform.concat()
        NSColor(srgbRed: 24.0 / 255, green: 24.0 / 255, blue: 24.0 / 255, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 2, y: 2, width: 60, height: 60), xRadius: 14, yRadius: 14).fill()
        NSColor(srgbRed: 250.0 / 255, green: 250.0 / 255, blue: 250.0 / 255, alpha: 1).setFill()
        let shore = NSBezierPath()
        shore.move(to: NSPoint(x: 16, y: 16))
        shore.line(to: NSPoint(x: 24, y: 16))
        shore.line(to: NSPoint(x: 24, y: 40))
        shore.line(to: NSPoint(x: 48, y: 40))
        shore.line(to: NSPoint(x: 48, y: 48))
        shore.line(to: NSPoint(x: 16, y: 48))
        shore.close()
        shore.fill()
        NSBezierPath(rect: NSRect(x: 32, y: 16, width: 16, height: 16)).fill()
        NSGraphicsContext.restoreGraphicsState()
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try rep.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent(name))
        if pixels == 1024 { try rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("icon.png")) }
    }
}

import AppKit
import Foundation

private let outputSize = NSSize(width: 1024, height: 1024)

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: render-app-icon INPUT_SVG OUTPUT_PNG\n", stderr)
    exit(64)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = NSImage(contentsOf: sourceURL),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(outputSize.width),
        pixelsHigh: Int(outputSize.height),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      ),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fputs("render-app-icon: could not load or rasterize the SVG\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.clear.setFill()
NSRect(origin: .zero, size: outputSize).fill()
source.draw(
    in: NSRect(origin: .zero, size: outputSize),
    from: NSRect(origin: .zero, size: source.size),
    operation: .sourceOver,
    fraction: 1
)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("render-app-icon: could not encode the rendered PNG\n", stderr)
    exit(1)
}

do {
    try png.write(to: outputURL, options: .atomic)
} catch {
    fputs("render-app-icon: \(error.localizedDescription)\n", stderr)
    exit(1)
}

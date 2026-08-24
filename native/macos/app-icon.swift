import AppKit
import Foundation

private let iconSize = NSSize(width: 1024, height: 1024)

private func color(_ red: Int, _ green: Int, _ blue: Int, alpha: CGFloat = 1) -> NSColor {
    NSColor(
        calibratedRed: CGFloat(red) / 255,
        green: CGFloat(green) / 255,
        blue: CGFloat(blue) / 255,
        alpha: alpha
    )
}

private func roundedRect(
    _ rect: NSRect,
    radius: CGFloat,
    fill: NSColor,
    stroke: NSColor? = nil,
    lineWidth: CGFloat = 1
) {
    let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    fill.setFill()
    path.fill()
    if let stroke {
        stroke.setStroke()
        path.lineWidth = lineWidth
        path.stroke()
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: app-icon OUTPUT_PNG\n", stderr)
    exit(64)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let bitmapContext = CGContext(
    data: nil,
    width: Int(iconSize.width),
    height: Int(iconSize.height),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fputs("app-icon: could not create bitmap context\n", stderr)
    exit(1)
}

let graphicsContext = NSGraphicsContext(cgContext: bitmapContext, flipped: true)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphicsContext
NSColor.clear.setFill()
NSRect(origin: .zero, size: iconSize).fill()

let tile = NSRect(x: 42, y: 42, width: 940, height: 940)
roundedRect(
    tile,
    radius: 218,
    fill: color(21, 25, 18),
    stroke: color(168, 205, 114, alpha: 0.28),
    lineWidth: 4
)
NSGraphicsContext.saveGraphicsState()
NSBezierPath(roundedRect: tile, xRadius: 218, yRadius: 218).addClip()
NSGradient(
    starting: color(38, 45, 31, alpha: 0.72),
    ending: color(21, 25, 18, alpha: 0)
)?.draw(in: NSRect(x: 44, y: 44, width: 936, height: 470), angle: 90)
NSGraphicsContext.restoreGraphicsState()

roundedRect(
    NSRect(x: 168, y: 168, width: 334, height: 334),
    radius: 76,
    fill: color(168, 205, 114)
)
roundedRect(
    NSRect(x: 590, y: 168, width: 264, height: 264),
    radius: 64,
    fill: color(124, 158, 76)
)
roundedRect(
    NSRect(x: 168, y: 590, width: 264, height: 264),
    radius: 64,
    fill: color(124, 158, 76)
)
roundedRect(
    NSRect(x: 522, y: 522, width: 332, height: 332),
    radius: 76,
    fill: color(202, 224, 166)
)

graphicsContext.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let rendered = bitmapContext.makeImage(),
      let outputContext = CGContext(
        data: nil,
        width: Int(iconSize.width),
        height: Int(iconSize.height),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else {
    fputs("app-icon: could not render icon\n", stderr)
    exit(1)
}
outputContext.translateBy(x: 0, y: iconSize.height)
outputContext.scaleBy(x: 1, y: -1)
outputContext.draw(rendered, in: NSRect(origin: .zero, size: iconSize))
guard let oriented = outputContext.makeImage() else {
    fputs("app-icon: could not orient icon\n", stderr)
    exit(1)
}

let bitmap = NSBitmapImageRep(cgImage: oriented)
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("app-icon: could not encode icon\n", stderr)
    exit(1)
}

do {
    try png.write(to: output, options: .atomic)
} catch {
    fputs("app-icon: \(error.localizedDescription)\n", stderr)
    exit(1)
}

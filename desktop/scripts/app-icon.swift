import AppKit

// Use the approved shell and eye coordinates shared with the web and native pet.
struct CompanionLayout: Decodable {
    struct Box: Decodable { let x, y, width, height: CGFloat }
    struct Eye: Decodable { let cx, cy, width, height, angle: CGFloat }
    struct Canvas: Decodable { let width, height: CGFloat }
    let canvas: Canvas
    let viewport: Box
    let eyes: [Eye]
}
let destination = CommandLine.arguments[1]
let assets = URL(fileURLWithPath: CommandLine.arguments[2])
let layout = try JSONDecoder().decode(CompanionLayout.self,
    from: Data(contentsOf: assets.appendingPathComponent("companion-layout.json")))
guard let shell = NSImage(contentsOf: assets.appendingPathComponent("companion-shell.png")) else {
    fatalError("Approved companion shell is missing")
}
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
    NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}

func render(_ pixels: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(pixels) / 1024)
    transform.concat()
    let background = NSBezierPath(roundedRect: NSRect(x: 28, y: 28, width: 968, height: 968), xRadius: 210, yRadius: 210)
    NSGradient(starting: color(51, 51, 50), ending: color(24, 25, 27))!.draw(in: background, angle: -90)

    let scale: CGFloat = 756 / layout.viewport.width
    let origin = NSPoint(x: (1024 - layout.viewport.width * scale) / 2,
                         y: (1024 - layout.viewport.height * scale) / 2)
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(rect: NSRect(origin: origin, size: NSSize(width: layout.viewport.width * scale,
                                                        height: layout.viewport.height * scale))).addClip()
    shell.draw(in: NSRect(x: origin.x - layout.viewport.x * scale,
                         y: origin.y - (layout.canvas.height - layout.viewport.y - layout.viewport.height) * scale,
                         width: layout.canvas.width * scale, height: layout.canvas.height * scale),
               from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    for eye in layout.eyes {
        NSGraphicsContext.saveGraphicsState()
        let eyeTransform = NSAffineTransform()
        eyeTransform.translateX(by: origin.x + (eye.cx - layout.viewport.x) * scale,
                                yBy: origin.y + (layout.viewport.y + layout.viewport.height - eye.cy) * scale)
        eyeTransform.rotate(byDegrees: -eye.angle)
        eyeTransform.concat()
        let capsule = NSBezierPath(roundedRect: NSRect(x: -eye.width * scale / 2,
                                                      y: -eye.height * scale / 2,
                                                      width: eye.width * scale, height: eye.height * scale),
                                   xRadius: eye.width * scale / 2, yRadius: eye.width * scale / 2)
        let top = color(255, 248, 235)
        let bottom = color(241, 226, 208)
        NSGradient(starting: top, ending: bottom)!.draw(in: capsule, angle: -90)
        NSGraphicsContext.restoreGraphicsState()
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        let url = URL(fileURLWithPath: destination).appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        try render(points * scale).write(to: url)
    }
}

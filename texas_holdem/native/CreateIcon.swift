import Cocoa
let directory = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let w = CGFloat(pixels)
        NSColor(calibratedRed: 0.075, green: 0.16, blue: 0.115, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: w), xRadius: w * 0.22, yRadius: w * 0.22).fill()
        NSColor(calibratedRed: 0.4, green: 0.5, blue: 0.32, alpha: 0.6).setStroke()
        let border = NSBezierPath(roundedRect: NSRect(x: w * 0.075, y: w * 0.075, width: w * 0.85, height: w * 0.85), xRadius: w * 0.17, yRadius: w * 0.17)
        border.lineWidth = max(1, w * 0.009)
        border.stroke()
        let text = "♠" as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Georgia", size: w * 0.76) ?? NSFont.systemFont(ofSize: w * 0.76), .foregroundColor: NSColor(calibratedRed: 0.83, green: 0.86, blue: 0.68, alpha: 1)]
        let bounds = text.size(withAttributes: attrs)
        text.draw(at: NSPoint(x: (w - bounds.width) / 2, y: (w - bounds.height) / 2 + w * 0.01), withAttributes: attrs)
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}

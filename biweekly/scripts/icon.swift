import Cocoa
let output = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width:1024,height:1024))
image.lockFocus()
NSColor(calibratedRed:0.965,green:0.955,blue:0.987,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:70,y:70,width:884,height:884),xRadius:205,yRadius:205).fill()
let gradient=NSGradient(starting:NSColor(calibratedRed:0.53,green:0.46,blue:0.85,alpha:1),ending:NSColor(calibratedRed:0.38,green:0.31,blue:0.69,alpha:1))!
gradient.draw(in:NSBezierPath(roundedRect:NSRect(x:125,y:125,width:774,height:774),xRadius:165,yRadius:165),angle:270)
NSColor.white.setFill();NSBezierPath(roundedRect:NSRect(x:320,y:300,width:145,height:435),xRadius:50,yRadius:50).fill()
NSColor.white.withAlphaComponent(0.63).setFill();NSBezierPath(roundedRect:NSRect(x:550,y:300,width:145,height:295),xRadius:50,yRadius:50).fill()
image.unlockFocus()
let data=NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!
try data.write(to:URL(fileURLWithPath:output))

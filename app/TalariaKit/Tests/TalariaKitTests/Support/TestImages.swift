import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Synthetic images for tests, drawn with Core Graphics so they work on macOS and iOS alike.
enum TestImages {
    /// A solid blue PNG of the given pixel size.
    static func pngData(width: Int, height: Int) -> Data? {
        encode(width: width, height: height, type: .png, quality: nil) { context in
            context.setFillColor(CGColor(red: 0, green: 0.48, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    /// A JPEG split into blue and teal halves, of the given pixel size.
    static func jpegData(width: Int, height: Int) -> Data? {
        encode(width: width, height: height, type: .jpeg, quality: 0.9) { context in
            context.setFillColor(CGColor(red: 0, green: 0.48, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.setFillColor(CGColor(red: 0.19, green: 0.69, blue: 0.78, alpha: 1))
            context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
        }
    }

    private static func encode(width: Int, height: Int, type: UTType, quality: Double?, draw: (CGContext) -> Void) -> Data? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        draw(context)
        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        let options = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

#if canImport(UIKit)
import UIKit

extension UIImage {
    var testCGImage: CGImage? { cgImage }
}
#else
import AppKit

extension NSImage {
    var testCGImage: CGImage? { cgImage(forProposedRect: nil, context: nil, hints: nil) }
}
#endif

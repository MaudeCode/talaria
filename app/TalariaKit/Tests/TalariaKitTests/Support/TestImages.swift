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

    /// A `jpegData` image tagged with synthetic camera EXIF and GPS coordinates, as a phone photo carries them.
    static func jpegDataWithLocation(width: Int, height: Int) -> Data? {
        encode(width: width, height: height, type: .jpeg, quality: 0.9, properties: [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 37.33, kCGImagePropertyGPSLatitudeRef: "N",
                                            kCGImagePropertyGPSLongitude: 122.03, kCGImagePropertyGPSLongitudeRef: "W"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifLensModel: "Synthetic lens",
                                             kCGImagePropertyExifDateTimeOriginal: "2026:01:02 03:04:05"]
        ]) { context in
            context.setFillColor(CGColor(red: 0, green: 0.48, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    /// An opaque HEIC split like `jpegData`, as the Photos library stores camera shots.
    static func heicData(width: Int, height: Int, orientation: Int? = nil) -> Data? {
        encode(width: width, height: height, type: .heic, quality: 0.9, alpha: .noneSkipLast, orientation: orientation) { context in
            context.setFillColor(CGColor(red: 0, green: 0.48, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.setFillColor(CGColor(red: 0.19, green: 0.69, blue: 0.78, alpha: 1))
            context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
        }
    }

    /// A half-transparent blue PNG of the given pixel size.
    static func translucentPNGData(width: Int, height: Int) -> Data? {
        encode(width: width, height: height, type: .png, quality: nil) { context in
            context.setFillColor(CGColor(red: 0, green: 0.48, blue: 1, alpha: 0.5))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private static func encode(
        width: Int,
        height: Int,
        type: UTType,
        quality: Double?,
        alpha: CGImageAlphaInfo = .premultipliedLast,
        orientation: Int? = nil,
        properties: [CFString: Any] = [:],
        draw: (CGContext) -> Void
    ) -> Data? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: alpha.rawValue
        ) else { return nil }
        draw(context)
        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        var options = properties
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        if let orientation { options[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
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

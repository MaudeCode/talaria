// The one platform type TalariaKit names directly: a decoded image. On iOS it is `UIImage`, so App code and TalariaKit
// exchange the same values as before; macOS, where `swift test` runs, uses `NSImage`.
#if canImport(UIKit)
import UIKit

public typealias PlatformImage = UIImage

extension UIImage {
    /// Bytes the decoded bitmap occupies, the `DecodedImageCache` cost.
    var decodedByteCost: Int {
        if let cgImage {
            return cgImage.bytesPerRow * cgImage.height
        }

        return Int(size.width * scale) * Int(size.height * scale) * 4
    }
}
#else
import AppKit

public typealias PlatformImage = NSImage

extension NSImage {
    var decodedByteCost: Int {
        Int(size.width) * Int(size.height) * 4
    }
}
#endif

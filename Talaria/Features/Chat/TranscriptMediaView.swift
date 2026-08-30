import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct TranscriptMediaPreviewItem: Identifiable, Equatable {
    let reference: TranscriptMediaReference

    var id: String {
        reference.id
    }
}








actor DecodedImageCache {
    static let shared = DecodedImageCache()

    private let cache: NSCache<NSString, UIImage>
    private var inFlight: [DecodedImageCacheKey: Task<UIImage?, Never>] = [:]

    init(totalCostLimit: Int = 64 * 1_024 * 1_024) {
        cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = totalCostLimit
    }

    func image(
        for key: DecodedImageCacheKey,
        load: @escaping () async -> UIImage?
    ) async -> UIImage? {
        if let cached = cache.object(forKey: key.cacheKey) {
            return cached
        }

        if let task = inFlight[key] {
            return await task.value
        }

        let task = Task<UIImage?, Never> { await load() }

        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil

        if let image {
            cache.setObject(image, forKey: key.cacheKey, cost: image.decodedByteCost)
        }
        return image
    }
}

struct DecodedImageCacheKey: Hashable {
    let namespace: String
    let resourceID: String

    var cacheKey: NSString {
        "\(namespace.utf8.count):\(namespace)\(resourceID)" as NSString
    }
}

private extension UIImage {
    var decodedByteCost: Int {
        if let cgImage {
            return cgImage.bytesPerRow * cgImage.height
        }

        return Int(size.width * scale) * Int(size.height * scale) * 4
    }
}

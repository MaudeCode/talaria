import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

public struct TranscriptMediaPreviewItem: Identifiable, Equatable {
    public let reference: TranscriptMediaReference

    public init(reference: TranscriptMediaReference) {
        self.reference = reference
    }

    public var id: String {
        reference.id
    }
}

public actor DecodedImageCache {
    public static let shared = DecodedImageCache()

    private let cache: NSCache<NSString, PlatformImage>
    private var inFlight: [DecodedImageCacheKey: Task<PlatformImage?, Never>] = [:]

    init(totalCostLimit: Int = 64 * 1_024 * 1_024) {
        cache = NSCache<NSString, PlatformImage>()
        cache.totalCostLimit = totalCostLimit
    }

    public func image(
        for key: DecodedImageCacheKey,
        load: @escaping () async -> PlatformImage?
    ) async -> PlatformImage? {
        if let cached = cache.object(forKey: key.cacheKey) {
            return cached
        }

        if let task = inFlight[key] {
            return await task.value
        }

        let task = Task<PlatformImage?, Never> { await load() }

        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil

        if let image {
            cache.setObject(image, forKey: key.cacheKey, cost: image.decodedByteCost)
        }
        return image
    }
}

public struct DecodedImageCacheKey: Hashable {
    let namespace: String
    let resourceID: String

    public init(namespace: String, resourceID: String) {
        self.namespace = namespace
        self.resourceID = resourceID
    }

    var cacheKey: NSString {
        "\(namespace.utf8.count):\(namespace)\(resourceID)" as NSString
    }
}

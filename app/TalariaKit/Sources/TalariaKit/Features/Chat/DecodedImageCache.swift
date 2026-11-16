import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

public struct TranscriptMediaPreviewItem: Identifiable, Equatable, Sendable {
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
        load: @escaping @Sendable () async -> PlatformImage?
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

    /// The image `loadData` returns, kept at the size it is shown: decoded off the caller's actor, scaled down
    /// until it just covers `pixelSize` (TAL-1238). The cache never holds the full-size bitmap.
    public func thumbnail(
        for key: DecodedImageCacheKey,
        covering pixelSize: CGSize,
        loadData: @escaping @Sendable () async -> Data?
    ) async -> PlatformImage? {
        await image(for: key) {
            guard let data = await loadData() else { return nil }
            return await ImagePreviewDownsampler.thumbnailImage(from: data, covering: pixelSize)
        }
    }
}

public struct DecodedImageCacheKey: Hashable, Sendable {
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

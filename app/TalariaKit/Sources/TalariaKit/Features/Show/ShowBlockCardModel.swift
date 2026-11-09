import Foundation
import Observation
import UniformTypeIdentifiers

/// TAL-1968: a `show` block's transcript section. A block never changes once stored, so one read fills it; an image
/// file also reads its bytes, and an HTML block's frame URL resolves under this server.
@MainActor
@Observable
public final class ShowBlockCardModel {
    public let blockID: String
    public private(set) var block: ShowBlock?
    /// An image file's bytes, once read.
    public private(set) var imageData: Data?
    /// The block could not be read; the section shows its title alone.
    public private(set) var failed = false
    @ObservationIgnored private let client: APIClient

    public init(blockID: String, client: APIClient) {
        self.blockID = blockID
        self.client = client
    }

    /// The sandboxed page's URL under this server; nil for any other kind.
    public var frameURL: URL? {
        block?.frameUrl.flatMap(client.showBlockURL)
    }

    /// TAL-1971: a delivered file's bytes through the authenticated raw route, named and typed for Share and Save to Files.
    public func deliveredFile() async throws -> FileExportPayload {
        guard let block, let file = block.file, let delivery = block.delivery else { throw URLError(.fileDoesNotExist) }
        // ponytail: whole file in memory (at most 200 MB); stream to disk if large deliveries become common.
        let data = try await client.rawFileData(sessionID: block.sessionId, path: file.path)
        let type = UTType(mimeType: delivery.mime).flatMap { $0 == .data ? nil : $0 }
            ?? UTType(filenameExtension: URL(fileURLWithPath: file.name).pathExtension)
            ?? .data
        return FileExportPayload(data: data, filename: file.name, contentType: type, isImage: type.conforms(to: .image), isVideo: type.conforms(to: .movie))
    }

    public func load() async {
        do {
            let block = try await client.showBlock(id: blockID)
            self.block = block
            failed = false
            if block.media?.kind == "image", let file = block.file {
                imageData = try? await client.rawFileData(sessionID: block.sessionId, path: file.path)
            }
        } catch {
            if block == nil { failed = true }
        }
    }
}

import Foundation
import Observation

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

import SwiftUI

/// Sheet state for one linked skill file. Responses carry the file name they
/// were requested for, so a slow request cannot land in a later presentation.
public struct SkillLinkedFileSelection: Identifiable, Equatable {
    public let fileName: String
    public private(set) var content: String?

    public var id: String { fileName }
    public var isLoading: Bool { content == nil }

    public init(fileName: String) {
        self.fileName = fileName
    }

    /// Applies a response only when it belongs to the presented file.
    public mutating func apply(_ response: String, for fileName: String) {
        guard self.fileName == fileName else { return }
        content = response
    }

    public static func load(fileName: String, skill: String, client: APIClient) async -> String {
        do {
            return try await client.skillContent(name: skill, file: fileName).content ?? ""
        } catch {
            return String(localized: "Could not load file: \(error.localizedDescription)")
        }
    }
}

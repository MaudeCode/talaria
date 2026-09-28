import Foundation

public struct WorkspacesResponse: Decodable, Equatable {
    public let workspaces: [WorkspaceRoot]?
    public let last: String?
}

public struct WorkspaceSuggestionsResponse: Decodable, Equatable {
    public let suggestions: [String]?
    let prefix: String?
}

public struct WorkspaceRoot: Decodable, Equatable, Sendable {
    public let path: String?
    public let name: String?

    enum CodingKeys: String, CodingKey {
        case path
        case name
    }

    public init(from decoder: Decoder) throws {
        if let stringValue = try? decoder.singleValueContainer().decode(String.self) {
            path = stringValue
            name = nil
            return
        }

        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }
}

/// Response shape shared by the four workspace-registry mutation routes
/// (`/api/workspaces/add|remove|rename|reorder`). Verified against upstream
/// `_handle_workspace_*` handlers: `{"ok": true, "workspaces": [...]}` on success.
/// These routes are undocumented (not on the official docs site), so every field
/// stays optional and callers must tolerate a missing `workspaces` echo.
public struct WorkspaceMutationResponse: Decodable, Equatable {
    public let ok: Bool?
    public let workspaces: [WorkspaceRoot]?
    public let error: String?
}

/// Surfaced when a mutation route answers with HTTP success but reports
/// `ok: false` in the body. Upstream signals failure via non-2xx today, but
/// these routes are undocumented, so an explicit body-level failure must not
/// be presented as a success. Reuses the phrasing (and localization keys) of
/// `APIError`'s 400 handling.
public struct WorkspaceMutationRejection: LocalizedError, Equatable {
    let serverMessage: String?

    public init(serverMessage: String?) {
        self.serverMessage = serverMessage
    }

    public var errorDescription: String? {
        if let serverMessage, !serverMessage.isEmpty {
            return String(localized: "The server rejected the request: \(serverMessage)")
        }
        return String(localized: "The server rejected the request.")
    }
}

struct AddWorkspaceRequest: Encodable, Equatable {
    let path: String
    let name: String?
    let create: Bool?
}

struct RemoveWorkspaceRequest: Encodable, Equatable {
    let path: String
}

struct RenameWorkspaceRequest: Encodable, Equatable {
    let path: String
    let name: String
}

struct ReorderWorkspacesRequest: Encodable, Equatable {
    let paths: [String]
}

public struct DirectoryListResponse: Decodable, Equatable {
    public let entries: [WorkspaceEntry]?
    public let path: String?
    let workspace: String?
    let error: String?
}

public struct WorkspaceEntry: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String { path ?? fallbackIdentity.value }
    public var isBrowsableDirectory: Bool {
        isDirectory == true || type == "dir"
    }

    public let name: String?
    public let path: String?
    public let type: String?
    public let size: Int?
    let modified: Double?
    let isDirectory: Bool?

    enum CodingKeys: String, CodingKey {
        case name
        case path
        case type
        case size
        case modified
        case isDirectory
        case isDir
    }

    /// A file named outside a directory listing, such as a chat link's target.
    public init(name: String, path: String) {
        self.name = name
        self.path = path
        type = "file"
        size = nil
        modified = nil
        isDirectory = false
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        size = try container.decodeIfPresent(Int.self, forKey: .size)
        modified = try container.decodeIfPresent(Double.self, forKey: .modified)
        isDirectory = try container.decodeIfPresent(Bool.self, forKey: .isDirectory)
            ?? container.decodeIfPresent(Bool.self, forKey: .isDir)
    }
}

public struct FileResponse: Decodable, Equatable {
    public let content: String?
    public let path: String?
    let name: String?
    public let language: String?
    public let size: Int?
    public let lines: Int?
    let error: String?
}

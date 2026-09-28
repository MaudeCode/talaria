import Foundation

public enum MemorySection: String, CaseIterable, Decodable, Encodable, Equatable, Identifiable {
    case memory
    case user
    case soul

    public var id: String { rawValue }
}

public struct MemoryResponse: Decodable, Equatable {
    public let memory: String?
    public let user: String?
    public let soul: String?
    let memoryPath: String?
    let userPath: String?
    let soulPath: String?
    public let memoryMtime: Double?
    public let userMtime: Double?
    public let soulMtime: Double?
    public let projectContext: String?
    public let projectContextName: String?
    let projectContextPath: String?
    public let projectContextWorkspace: String?
    public let projectContextMtime: Double?
    public let projectContextShadowed: Bool?
    public let externalNotesEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case memory
        case user
        case soul
        case memoryPath
        case userPath
        case soulPath
        case memoryMtime
        case userMtime
        case soulMtime
        case projectContext
        case projectContextName
        case projectContextPath
        case projectContextWorkspace
        case projectContextMtime
        case projectContextShadowed
        case externalNotesEnabled
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        memory = try container.decodeIfPresent(String.self, forKey: .memory)
        user = try container.decodeIfPresent(String.self, forKey: .user)
        soul = try container.decodeIfPresent(String.self, forKey: .soul)
        memoryPath = try container.decodeIfPresent(String.self, forKey: .memoryPath)
        userPath = try container.decodeIfPresent(String.self, forKey: .userPath)
        soulPath = try container.decodeIfPresent(String.self, forKey: .soulPath)
        memoryMtime = try container.decodeFlexibleDoubleIfPresent(forKey: .memoryMtime)
        userMtime = try container.decodeFlexibleDoubleIfPresent(forKey: .userMtime)
        soulMtime = try container.decodeFlexibleDoubleIfPresent(forKey: .soulMtime)
        projectContext = try container.decodeIfPresent(String.self, forKey: .projectContext)
        projectContextName = try container.decodeIfPresent(String.self, forKey: .projectContextName)
        projectContextPath = try container.decodeIfPresent(String.self, forKey: .projectContextPath)
        projectContextWorkspace = try container.decodeIfPresent(
            String.self,
            forKey: .projectContextWorkspace
        )
        projectContextMtime = try container.decodeFlexibleDoubleIfPresent(forKey: .projectContextMtime)
        // Upstream (routes.py @ 312d3fab, verified live 2026-07-03) returns a *list* of
        // shadowed-file objects here; the API docs describe a boolean flag. Accept both:
        // `true` or a non-empty list means the active document shadows another file.
        if let flag = try? container.decode(Bool.self, forKey: .projectContextShadowed) {
            projectContextShadowed = flag
        } else if let list = try? container.nestedUnkeyedContainer(forKey: .projectContextShadowed) {
            projectContextShadowed = (list.count ?? 0) > 0
        } else {
            projectContextShadowed = nil
        }
        externalNotesEnabled = (try? container.decodeIfPresent(Bool.self, forKey: .externalNotesEnabled)) ?? nil
    }
}

public struct MemoryWriteResponse: Decodable, Equatable {
    public let ok: Bool?
    let section: MemorySection?
    let path: String?
    public let error: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case section
        case path
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        if let rawSection = try container.decodeIfPresent(String.self, forKey: .section) {
            section = MemorySection(rawValue: rawSection)
        } else {
            section = nil
        }
        path = try container.decodeIfPresent(String.self, forKey: .path)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

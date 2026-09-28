public import Foundation

public struct SlashCommand: Identifiable, Equatable {
    public let id = UUID()
    public let name: String
    public let description: String
    public let argHint: String?
    let noEcho: Bool
    public let handler: SlashCommandHandler
    public let subArgs: SlashCommandSubArgs

    public init(
        name: String,
        description: String,
        argHint: String? = nil,
        noEcho: Bool = false,
        handler: SlashCommandHandler = .unsupported,
        subArgs: SlashCommandSubArgs = .none
    ) {
        self.name = name
        self.description = description
        self.argHint = argHint
        self.noEcho = noEcho
        self.handler = handler
        self.subArgs = subArgs
    }

    public static func == (lhs: SlashCommand, rhs: SlashCommand) -> Bool {
        lhs.name == rhs.name
    }
}

public enum SlashCommandHandler: Equatable {
    case unsupported
    case clientSide(ClientSideAction)
    case serverSide(ServerSideAction)
}

public enum ClientSideAction: String, Equatable {
    case clear
    case stop
    case new
    case help
}

public enum ServerSideAction: String, Equatable {
    case model
    case workspace
    case reasoning
    case title
    case personality
    case skills
    case compress
    case retry
    case undo
    case branch
    case queue
    case steer
    case interrupt
    case status
    case btw
    case background
    case goal
}

public enum SlashCommandSubArgs: Equatable {
    case none
    case models
    case personalities
    case reasoningLevels
    case workspaces
    case skills
    case goalActions
}

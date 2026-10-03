import Foundation

/// TAL-372: one piece of background work a session owns (a delegated agent, a notified process, or a `/background`
/// task), as the server records it for every client. Decoded with `convertFromSnakeCase`; unknown values decode leniently.
public struct BackgroundWorkTask: Decodable, Equatable, Identifiable {
    public enum Kind: String, Equatable {
        case delegation, process
        case backgroundCommand = "background_command"
    }

    public enum Status: String, Equatable {
        case running, attention, completed, failed, cancelled, unknown
    }

    public struct Agents: Decodable, Equatable {
        public let total: Int
        public let completed: Int
        public let failed: Int
        public let running: Int

        public init(total: Int, completed: Int, failed: Int, running: Int) {
            self.total = total
            self.completed = completed
            self.failed = failed
            self.running = running
        }

        enum CodingKeys: String, CodingKey { case total, completed, failed, running }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            total = container.decodeLossyIntIfPresent(forKey: .total) ?? 0
            completed = container.decodeLossyIntIfPresent(forKey: .completed) ?? 0
            failed = container.decodeLossyIntIfPresent(forKey: .failed) ?? 0
            running = container.decodeLossyIntIfPresent(forKey: .running) ?? 0
        }
    }

    public var id: String { taskId }
    public let taskId: String
    public let kind: Kind
    public let status: Status
    public let title: String
    public let agents: Agents?
    public let exitCode: Int?
    public let resultAvailable: Bool
    public let pinned: Bool
    public let dismissible: Bool
    /// Not settled yet (running, attention or unknown): the App keeps refreshing while any record is active.
    public let active: Bool

    public init(taskId: String, kind: Kind, status: Status, title: String, agents: Agents? = nil, exitCode: Int? = nil, resultAvailable: Bool = false, pinned: Bool = false, dismissible: Bool = false, active: Bool = false) {
        self.taskId = taskId
        self.kind = kind
        self.status = status
        self.title = title
        self.agents = agents
        self.exitCode = exitCode
        self.resultAvailable = resultAvailable
        self.pinned = pinned
        self.dismissible = dismissible
        self.active = active
    }

    enum CodingKeys: String, CodingKey {
        case taskId, kind, status, title, agents, exitCode, resultAvailable, pinned, dismissible, active
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let taskId = container.decodeLossyStringIfPresent(forKey: .taskId), !taskId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .taskId, in: container, debugDescription: "A background task needs its id")
        }
        self.taskId = taskId
        kind = container.decodeLossyStringIfPresent(forKey: .kind).flatMap(Kind.init(rawValue:)) ?? .backgroundCommand
        status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(Status.init(rawValue:)) ?? .unknown
        title = container.decodeLossyStringIfPresent(forKey: .title) ?? ""
        agents = try? container.decodeIfPresent(Agents.self, forKey: .agents)
        exitCode = container.decodeLossyIntIfPresent(forKey: .exitCode)
        resultAvailable = container.decodeLossyBoolIfPresent(forKey: .resultAvailable) ?? false
        pinned = container.decodeLossyBoolIfPresent(forKey: .pinned) ?? false
        dismissible = container.decodeLossyBoolIfPresent(forKey: .dismissible) ?? false
        active = container.decodeLossyBoolIfPresent(forKey: .active) ?? false
    }
}

/// TAL-372: a delegation tool row's link to the work it started, updated in place (scene `tool.background`).
public struct BackgroundLink: Decodable, Equatable {
    public let taskIds: [String]
    public let status: BackgroundWorkTask.Status
    public let agents: BackgroundWorkTask.Agents

    public init(taskIds: [String], status: BackgroundWorkTask.Status, agents: BackgroundWorkTask.Agents) {
        self.taskIds = taskIds
        self.status = status
        self.agents = agents
    }

    enum CodingKeys: String, CodingKey { case taskIds, status, agents }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        taskIds = (try? container.decodeIfPresent([String].self, forKey: .taskIds)) ?? []
        status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(BackgroundWorkTask.Status.init(rawValue:)) ?? .unknown
        agents = try container.decode(BackgroundWorkTask.Agents.self, forKey: .agents)
    }
}

public struct BackgroundTasksResponse: Decodable, Equatable {
    public let tasks: [BackgroundWorkTask]
    public let agentAvailable: Bool

    enum CodingKeys: String, CodingKey { case tasks, agentAvailable }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = container.decodeLossyArrayIfPresent(BackgroundWorkTask.self, forKey: .tasks) ?? []
        agentAvailable = container.decodeLossyBoolIfPresent(forKey: .agentAvailable) ?? true
    }
}

public struct BackgroundTaskResult: Decodable, Equatable {
    public let taskId: String
    public let text: String
}

public struct BackgroundDismissResponse: Decodable, Equatable {
    public let ok: Bool
}

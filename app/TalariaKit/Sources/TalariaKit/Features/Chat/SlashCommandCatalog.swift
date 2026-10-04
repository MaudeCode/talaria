import Foundation

/// The iOS handlers and localized wording for client-handled slash commands, keyed by canonical name. Which commands
/// exist, their aliases, display order, and which clients run them come from the server catalog (`GET /api/commands`,
/// TAL-314).
public enum SlashCommandCatalog {
    private static let handlers: [String: SlashCommand] = Dictionary(uniqueKeysWithValues: [
        SlashCommand(
            name: "help",
            description: String(localized: "Show available slash commands"),
            noEcho: false,
            handler: .clientSide(.help)
        ),
        SlashCommand(
            name: "clear",
            description: String(localized: "Clear the current conversation"),
            noEcho: true,
            handler: .clientSide(.clear)
        ),
        SlashCommand(
            name: "model",
            description: String(localized: "Switch the active model"),
            argHint: String(localized: "model_name"),
            noEcho: true,
            handler: .serverSide(.model),
            subArgs: .models
        ),
        SlashCommand(
            name: "workspace",
            description: String(localized: "Switch the active workspace"),
            argHint: String(localized: "path"),
            noEcho: true,
            handler: .serverSide(.workspace),
            subArgs: .workspaces
        ),
        SlashCommand(
            name: "reasoning",
            description: String(localized: "Set reasoning effort level"),
            argHint: String(localized: "level"),
            noEcho: true,
            handler: .serverSide(.reasoning),
            subArgs: .reasoningLevels
        ),
        SlashCommand(
            name: "new",
            description: String(localized: "Start a new session"),
            noEcho: true,
            handler: .clientSide(.new)
        ),
        SlashCommand(
            name: "stop",
            description: String(localized: "Stop the current response"),
            noEcho: true,
            handler: .clientSide(.stop)
        ),
        SlashCommand(
            name: "title",
            description: String(localized: "Rename the current session"),
            argHint: String(localized: "name"),
            noEcho: false,
            handler: .serverSide(.title)
        ),
        SlashCommand(
            name: "personality",
            description: String(localized: "Set the session personality"),
            argHint: String(localized: "name"),
            noEcho: false,
            handler: .serverSide(.personality),
            subArgs: .personalities
        ),
        SlashCommand(
            name: "skills",
            description: String(localized: "Search available skills"),
            argHint: String(localized: "query"),
            noEcho: false,
            handler: .serverSide(.skills),
            subArgs: .skills
        ),
        SlashCommand(
            name: "compress",
            description: String(localized: "Compress session context"),
            argHint: String(localized: "focus topic"),
            noEcho: true,
            handler: .serverSide(.compress)
        ),
        SlashCommand(
            name: "retry",
            description: String(localized: "Retry the last turn"),
            noEcho: true,
            handler: .serverSide(.retry)
        ),
        SlashCommand(
            name: "undo",
            description: String(localized: "Undo the last exchange"),
            noEcho: true,
            handler: .serverSide(.undo)
        ),
        SlashCommand(
            name: "branch",
            description: String(localized: "Fork the conversation"),
            argHint: String(localized: "name"),
            noEcho: true,
            handler: .serverSide(.branch)
        ),
        SlashCommand(
            name: "queue",
            description: String(localized: "Queue a message for the next turn"),
            argHint: String(localized: "message"),
            noEcho: true,
            handler: .serverSide(.queue)
        ),
        SlashCommand(
            name: "steer",
            description: String(localized: "Steer the active response"),
            argHint: String(localized: "message"),
            noEcho: true,
            handler: .serverSide(.steer)
        ),
        SlashCommand(
            name: "interrupt",
            description: String(localized: "Stop the response and send a new message"),
            argHint: String(localized: "message"),
            noEcho: true,
            handler: .serverSide(.interrupt)
        ),
        SlashCommand(
            name: "status",
            description: String(localized: "Show session status"),
            noEcho: false,
            handler: .serverSide(.status)
        ),
        SlashCommand(
            name: "goal",
            description: String(localized: "Set or inspect a persistent goal"),
            argHint: "[status|pause|resume|clear|text]",
            noEcho: true,
            handler: .serverSide(.goal),
            subArgs: .goalActions
        ),
        SlashCommand(
            name: "btw",
            description: String(localized: "Ask a side question"),
            argHint: String(localized: "question"),
            noEcho: true,
            handler: .serverSide(.btw)
        ),
        SlashCommand(
            name: "background",
            description: String(localized: "Run a parallel task"),
            argHint: String(localized: "prompt"),
            noEcho: true,
            handler: .serverSide(.background)
        )
    ].map { ($0.name, $0) })

    /// The client-handled commands the catalog lists for iOS whose name or alias starts with `query`, in server order.
    public static func matching(_ query: String, in catalog: [AgentCommand]) -> [SlashCommand] {
        let prefix = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog
            .filter { $0.isCatalogEntry && $0.isClientHandled && $0.runsOnIOS && $0.matches(prefix: prefix) }
            .compactMap { $0.name.flatMap { handlers[$0.lowercased()] } }
    }

    /// The iOS handler for a typed name or alias. A catalog entry outside iOS has none; without a catalog entry the
    /// typed name is looked up directly, so commands still run before the catalog loads.
    public static func command(named name: String, in catalog: [AgentCommand] = []) -> SlashCommand? {
        guard let entry = catalog.entry(named: name) else { return handlers[name.lowercased()] }
        guard entry.runsOnIOS, let canonical = entry.name else { return nil }
        return handlers[canonical.lowercased()]
    }

    public static let reasoningLevels = ["show", "hide", "none", "minimal", "low", "medium", "high", "xhigh"]
    public static let goalActions = ["status", "pause", "resume", "clear"]
}

import Foundation

/// The Live Activity manager where ActivityKit is unavailable (macOS tests): every request is ignored. The App installs
/// its ActivityKit manager through `PlatformHooks.liveActivityManager`.
@MainActor
final class DisabledLiveActivityManager: AgentLiveActivityManaging {
    static let shared = DisabledLiveActivityManager()

    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date) {}
    func update(_ event: AgentLiveActivityEvent) {}
    func markStale() {}
    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?) {}
}

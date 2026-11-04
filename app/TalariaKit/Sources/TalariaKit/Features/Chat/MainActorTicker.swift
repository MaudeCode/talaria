import Foundation

/// Repeats `tick` on the main actor until the returned task is cancelled. A task rather than a `Timer` because the
/// main-actor owners stop it from their nonisolated `deinit`, and `Timer` is not `Sendable`. The main queue drains
/// while a scroll view tracks, so it keeps firing during a scroll as a `.common` mode timer did.
@MainActor
func startMainActorTicker(every interval: Duration, tick: @escaping @MainActor () -> Void) -> Task<Void, Never> {
    Task {
        while !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            tick()
        }
    }
}

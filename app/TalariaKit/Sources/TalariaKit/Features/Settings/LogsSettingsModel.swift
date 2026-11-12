import Foundation
import Observation

/// Owns the log tail read independently of ModelsSettingsViewModel's profile preferences.
@MainActor
@Observable
public final class LogsSettingsModel {
    public var file = "agent" { didSet { if file != oldValue { clearTail() } } }
    public var tail = 500 { didSet { if tail != oldValue { clearTail() } } }
    public private(set) var response: LogsResponse?
    public private(set) var files: [LogsResponse.File] = []
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public var text: String { (response?.lines ?? []).joined(separator: "\n") }

    @ObservationIgnored private let client: APIClient
    private var generation = 0

    public init(client: APIClient) { self.client = client }

    public func load() async {
        generation += 1
        let current = generation
        isLoading = true
        defer { if current == generation { isLoading = false } }
        do {
            let result = try await client.logs(file: file, tail: tail)
            guard current == generation, !Task.isCancelled else { return }
            response = result
            if let catalog = result.files { files = catalog }
            errorMessage = nil
        } catch {
            guard current == generation, !APIError.isCancellation(error), !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// SwiftUI owns cancellation when the page hides, its selection changes or the scene backgrounds.
    public func follow<C: Clock>(isActive: Bool, clock: C) async where C.Duration == Duration {
        guard isActive else { return }
        await SessionListAutoRefresh.run(refreshesImmediately: true, interval: .seconds(15), refresh: load, sleep: { try await clock.sleep(for: $0) })
    }

    private func clearTail() {
        generation += 1
        response = nil
        errorMessage = nil
        isLoading = false
    }
}

import Foundation
import Observation

/// Profile defaults, independent of a conversation. AuxiliaryModelsViewModel owns the separate task slots.
@MainActor
@Observable
public final class ModelsSettingsViewModel {
    public private(set) var defaultModel: String?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?

    private var status: ReasoningStatusResponse?
    private var effortOverride: (id: UUID, value: String)?
    private var thinkingOverride: (id: UUID, value: Bool)?
    private var unresolved: Set<UUID> = []
    private var generation = 0
    private var pendingWrites = 0
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private var writeTask: Task<Void, Never>?

    public init(client: APIClient) { self.client = client }

    public var showsReasoningEffort: Bool { status?.supportsReasoningEffort == true }
    public var showsThinkingToggle: Bool { status?.supportsThinkingToggle == true }
    public var supportedEfforts: [String] { status?.supportedEfforts ?? [] }
    public var reasoningEffort: String { effortOverride?.value ?? status?.effectiveEffort ?? "" }
    public var showThinking: Bool { thinkingOverride?.value ?? status?.showReasoning ?? false }

    public func load() async {
        while pendingWrites > 0 { await writeTask?.value }
        generation += 1
        let current = generation
        isLoading = true
        errorMessage = nil
        defer { if generation == current { isLoading = false } }
        do {
            let response = try await client.models()
            guard generation == current else { return }
            defaultModel = response.defaultModel
        } catch {
            guard generation == current else { return }
            if !APIError.isCancellation(error) { errorMessage = error.localizedDescription }
        }
        do {
            let response = try await client.reasoning()
            guard generation == current else { return }
            status = response
            clearResolvedOverrides()
        } catch {
            guard generation == current else { return }
            if !APIError.isCancellation(error) { errorMessage = error.localizedDescription }
        }
    }

    public func defaultModelChanged(_ model: String) async {
        defaultModel = model
        await load()
    }

    @discardableResult
    public func setReasoningEffort(_ effort: String) -> Task<Void, Never> {
        let id = UUID()
        effortOverride = (id, effort)
        return enqueue(id: id) { try await self.client.saveReasoningEffort(effort, sessionID: nil) }
    }

    @discardableResult
    public func setShowThinking(_ show: Bool) -> Task<Void, Never> {
        let id = UUID()
        thinkingOverride = (id, show)
        return enqueue(id: id) { try await self.client.saveReasoningDisplay(show ? "show" : "hide") }
    }

    /// Serialize writes while retaining each field's newest optimistic choice over older full-status replies.
    private func enqueue(id: UUID, write: @escaping @MainActor () async throws -> ReasoningStatusResponse) -> Task<Void, Never> {
        generation += 1
        isLoading = false
        errorMessage = nil
        pendingWrites += 1
        let previous = writeTask
        let task = Task {
            await previous?.value
            defer { pendingWrites -= 1 }
            do {
                let response = try await write()
                if response.ok == false || response.error != nil {
                    throw APIError.http(statusCode: 400, body: response.error ?? String(localized: "The server did not confirm the change."))
                }
                status = response
                clearOverride(id)
                clearResolvedOverrides()
            } catch {
                if APIError.isDefinitiveWriteFailure(error) {
                    clearOverride(id)
                } else {
                    // An unknown outcome is never replayed. Keep the choice until a successful read decides it.
                    do {
                        status = try await client.reasoning()
                        clearOverride(id)
                        clearResolvedOverrides()
                    } catch {
                        unresolved.insert(id)
                    }
                }
                errorMessage = error.localizedDescription
            }
        }
        writeTask = task
        return task
    }

    private func clearOverride(_ id: UUID) {
        if effortOverride?.id == id { effortOverride = nil }
        if thinkingOverride?.id == id { thinkingOverride = nil }
        unresolved.remove(id)
    }

    private func clearResolvedOverrides() {
        for id in unresolved { clearOverride(id) }
    }
}

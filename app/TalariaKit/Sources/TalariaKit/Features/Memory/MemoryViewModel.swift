import Foundation
import Observation

@MainActor
@Observable
public final class MemoryViewModel {
    private(set) var memoryText: String?
    private(set) var userText: String?
    private(set) var soulText: String?
    private(set) var memoryMtime: Date?
    private(set) var userMtime: Date?
    private(set) var soulMtime: Date?
    public private(set) var projectContextText: String?
    private(set) var projectContextName: String?
    private(set) var projectContextWorkspace: String?
    public private(set) var projectContextMtime: Date?
    public private(set) var isProjectContextShadowed = false
    private(set) var isExternalNotesEnabled: Bool?
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    public private(set) var lastError: Error?

    /// True while the screen shows the last saved memory rather than the server's (TAL-437).
    /// Saves carry no version check, so editing waits for the live content.
    public private(set) var isShowingCachedContent = false
    /// The section open in the editor. The file page presents it and the list's live refresh
    /// waits for it, so both columns read one value (TAL-643).
    public var editingSection: MemorySection?

    private let client: APIClient
    private let responseCache: ResponseCache?

    public init(server: URL, client: APIClient? = nil, responseCache: ResponseCache? = nil) {
        self.client = client ?? APIClient(baseURL: server)
        self.responseCache = responseCache
        if let cached = responseCache?.entry(ResponseCache.Kind.memory).load(MemoryResponse.self) {
            apply(cached)
            isShowingCachedContent = true
        }
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        lastError = nil
        defer { isLoading = false }

        do {
            let response = try await client.memory(caching: responseCache?.entry(ResponseCache.Kind.memory))
            apply(response)
            isShowingCachedContent = false
        } catch {
            // The view model outlives its screen (TAL-643), so a rebuilt screen's cancelled
            // load must not replace what the new load shows.
            guard !APIError.isCancellation(error) else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    public func clearActionError() {
        actionErrorMessage = nil
    }

    /// The read-only project-context section only appears when the server sent a
    /// non-empty document. Servers without the field (or with an empty/blank one,
    /// which is what upstream returns when no readable context file exists) render
    /// the screen exactly as before.
    public var showsProjectContext: Bool {
        guard let text = projectContextText else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Non-localized "name — workspace" detail line for the project-context section.
    public var projectContextDetail: String? {
        let parts = [projectContextName, projectContextWorkspace]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " — ")
    }

    public func content(for section: MemorySection) -> String {
        switch section {
        case .memory:
            return memoryText ?? ""
        case .user:
            return userText ?? ""
        case .soul:
            return soulText ?? ""
        }
    }

    public func modifiedAt(for section: MemorySection) -> Date? {
        switch section {
        case .memory:
            return memoryMtime
        case .user:
            return userMtime
        case .soul:
            return soulMtime
        }
    }

    public func save(section: MemorySection, content: String) async -> Bool {
        isSaving = true
        actionErrorMessage = nil
        lastError = nil
        defer { isSaving = false }

        do {
            let writeResponse = try await client.writeMemory(section: section, content: content)
            guard writeResponse.ok != false else {
                actionErrorMessage = writeResponse.error ?? String(localized: "Could not save memory.")
                return false
            }

            let refreshed = try await client.memory()
            apply(refreshed)
            return true
        } catch {
            lastError = error
            actionErrorMessage = error.localizedDescription
            return false
        }
    }

    private func apply(_ response: MemoryResponse) {
        memoryText = response.memory
        userText = response.user
        soulText = response.soul
        memoryMtime = response.memoryMtime.map { Date(timeIntervalSince1970: $0) }
        userMtime = response.userMtime.map { Date(timeIntervalSince1970: $0) }
        soulMtime = response.soulMtime.map { Date(timeIntervalSince1970: $0) }
        projectContextText = response.projectContext
        projectContextName = response.projectContextName
        projectContextWorkspace = response.projectContextWorkspace
        projectContextMtime = response.projectContextMtime.map { Date(timeIntervalSince1970: $0) }
        isProjectContextShadowed = response.projectContextShadowed ?? false
        isExternalNotesEnabled = response.externalNotesEnabled
        hasLoaded = true
    }
}

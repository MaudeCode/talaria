import CryptoKit
import Foundation
import Observation

@MainActor
@Observable
public final class TalariaCompletionStore {
    public static let shared = TalariaCompletionStore()
    public private(set) var completions: [TalariaRelayClient.Completion] = []
    private(set) var cursor: String?
    public private(set) var isLoading = false
    private(set) var isAcknowledging = false
    public private(set) var errorMessage: String?
    private var generation = 0
    private var scope: String?
    private let defaults: UserDefaults
    private let credentials: () -> TalariaRelayCredentials?
    private let session: URLSession?
    private static let cacheKey = "relay.pendingCompletions.v1"

    private struct Cache: Codable {
        var scope: String
        var completions: [TalariaRelayClient.Completion]
        var cursor: String?
    }

    public init(defaults: UserDefaults = .standard, session: URLSession? = nil,
         credentials: @escaping () -> TalariaRelayCredentials? = { TalariaRelayConfigurationStore.load() }) {
        self.defaults = defaults
        self.session = session
        self.credentials = credentials
    }

    private func currentScope(_ value: TalariaRelayCredentials) -> String {
        SHA256.hash(data: Data("\(value.baseURL)|\(value.userID)|\(value.deviceID)|\(value.sessionToken)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    private func client() -> (TalariaRelayClient, String)? {
        guard let credentials = credentials(), !credentials.isExpired, credentials.pendingRevocation != true else {
            generation += 1
            scope = nil
            isLoading = false
            errorMessage = nil
            completions = []
            cursor = nil
            defaults.removeObject(forKey: Self.cacheKey)
            return nil
        }
        let nextScope = currentScope(credentials)
        if scope != nextScope {
            generation += 1
            scope = nextScope
            isLoading = false
            let cached = defaults.data(forKey: Self.cacheKey).flatMap { try? JSONDecoder().decode(Cache.self, from: $0) }
            completions = cached?.scope == nextScope ? cached!.completions : []
            cursor = cached?.scope == nextScope ? cached?.cursor : nil
            errorMessage = nil
        }
        return (TalariaRelayClient(credentials: credentials, session: session), nextScope)
    }

    private func isCurrent(_ expectedScope: String, generation expectedGeneration: Int) -> Bool {
        guard let value = credentials(), !value.isExpired, value.pendingRevocation != true else { return false }
        return generation == expectedGeneration && currentScope(value) == expectedScope
    }

    private func save() {
        guard let scope, let data = try? JSONEncoder().encode(Cache(scope: scope, completions: completions, cursor: cursor)) else { return }
        defaults.set(data, forKey: Self.cacheKey)
    }

    @discardableResult
    func refresh(loadMore: Bool = false) async -> Bool {
        guard let (client, scope) = client(), !isAcknowledging else { return false }
        generation += 1
        let requestGeneration = generation
        isLoading = true
        defer { if generation == requestGeneration { isLoading = false } }
        do {
            let page = try await client.completions(cursor: loadMore ? cursor : nil)
            guard isCurrent(scope, generation: requestGeneration), !Task.isCancelled else { return false }
            let existing = loadMore ? completions : []
            let known = Set(existing.map(\.id))
            completions = existing + page.completions.filter { !known.contains($0.id) }
            cursor = page.cursor
            errorMessage = nil
            save()
            return true
        } catch {
            guard isCurrent(scope, generation: requestGeneration), !Task.isCancelled else { return false }
            if case TalariaRelayClient.ClientError.invalidResponse(let status, _) = error, status == 401 || status == 403 {
                completions = []
                cursor = nil
                save()
            }
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func acknowledgeViewedSession(publisherURL: URL, sessionID: String, through viewedAt: Date) async -> [TalariaRelayClient.Completion]? {
        guard let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString,
              let (_, expectedScope) = client() else { return nil }
        guard await refresh(), scope == expectedScope, !Task.isCancelled else { return nil }
        // ponytail: page the inbox for thread acknowledgement; add a server-side
        // session filter if very large inboxes make this slow.
        var seenCursors = Set<String>()
        while let cursor, seenCursors.insert(cursor).inserted {
            guard await refresh(loadMore: true), scope == expectedScope, !Task.isCancelled else { return nil }
        }
        guard cursor == nil else { return nil }
        let observed = completions.filter {
            $0.row.publisherId == publisherID && $0.row.sessionId == sessionID
                && $0.row.updatedAt <= viewedAt.timeIntervalSince1970 * 1_000
        }
        var acknowledged: [TalariaRelayClient.Completion] = []
        for offset in stride(from: 0, to: observed.count, by: 100) {
            guard scope == expectedScope, !Task.isCancelled else { return nil }
            let batch = Array(observed[offset..<min(offset + 100, observed.count)])
            guard await acknowledge(batch.map(\.id)) else { return nil }
            acknowledged += batch
        }
        return acknowledged
    }

    @discardableResult
    func acknowledge(_ ids: [String]) async -> Bool {
        guard !isAcknowledging, !ids.isEmpty, let (client, scope) = client() else { return false }
        let observed = Set(completions.map(\.id))
        guard ids.allSatisfy(observed.contains), ids.count <= 100 else { return false }
        generation += 1
        let requestGeneration = generation
        isAcknowledging = true
        isLoading = false
        defer { isAcknowledging = false }
        do {
            try await client.acknowledgeCompletions(ids: ids)
            guard isCurrent(scope, generation: requestGeneration) else { return false }
            let acknowledged = Set(ids)
            completions.removeAll { acknowledged.contains($0.id) }
            errorMessage = nil
            save()
            return true
        } catch {
            if isCurrent(scope, generation: requestGeneration) { errorMessage = error.localizedDescription }
            return false
        }
    }
}

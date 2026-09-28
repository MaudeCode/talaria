import ActivityKit
import Foundation

public enum TalariaAggregateActivitySeed {
    public static func make(
        sessionID: String,
        sessionTitle: String,
        publisherURL: URL,
        now: Date = Date()
    ) -> TalariaAggregateActivityAttributes.ContentState? {
        let normalizedSessionID = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSessionID.isEmpty,
              let publisherID = TalariaRelayClient.originURL(publisherURL)?.absoluteString else {
            return nil
        }
        let timestamp = now.timeIntervalSince1970 * 1_000
        return TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1,
            activeCount: 1,
            title: "Talaria",
            subtitle: String(localized: "1 active session"),
            updatedAt: timestamp,
            rows: [
                .init(
                    publisherId: publisherID,
                    publisherLabel: URL(string: publisherID)?.host() ?? "Hermes WebUI",
                    sessionId: normalizedSessionID,
                    title: AgentRunActivitySanitizer.sessionTitle(sessionTitle),
                    phase: "starting",
                    status: String(localized: "Connecting"),
                    updatedAt: timestamp,
                    deepLink: "/sessions/\(normalizedSessionID)"
                )
            ]
        )
    }

    public static func merging(
        _ seed: TalariaAggregateActivityAttributes.ContentState,
        into existing: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        guard let seedRow = seed.rows.first else { return existing }
        let matchingRow = existing.rows.first { $0.id == seedRow.id }
        let wasActive = matchingRow.map { activePhases.contains($0.phase) } ?? false
        let visibleActiveCount = existing.rows.filter { activePhases.contains($0.phase) }.count
        let sessionMayBeHidden = matchingRow == nil
            && existing.activeCount > visibleActiveCount
            && existing.updatedAt >= seed.updatedAt
        let activeCount = max(1, existing.activeCount + (wasActive || sessionMayBeHidden ? 0 : 1))
        let rows = ([seedRow] + existing.rows.filter { $0.id != seedRow.id })
            .sorted {
                let lhsPriority = displayPriority($0.phase)
                let rhsPriority = displayPriority($1.phase)
                return lhsPriority == rhsPriority
                    ? $0.updatedAt > $1.updatedAt
                    : lhsPriority < rhsPriority
            }
            .prefix(TalariaAggregateLiveActivityPresentation.lockScreenRowLimit)

        var merged = existing
        merged.activeCount = activeCount
        if !rows.contains(where: {
            $0.phase == "waiting_for_approval" || $0.phase == "waiting_for_input"
        }) {
            merged.subtitle = activeCount == 1
                ? String(localized: "1 active session")
                : String.localizedStringWithFormat(
                    String(localized: "%lld active sessions"),
                    activeCount
                )
        }
        merged.updatedAt = max(existing.updatedAt, seed.updatedAt)
        merged.rows = Array(rows)
        return merged
    }

    public static func merging(
        _ seeds: [TalariaAggregateActivityAttributes.ContentState],
        into existing: TalariaAggregateActivityAttributes.ContentState
    ) -> TalariaAggregateActivityAttributes.ContentState {
        seeds.sorted { $0.updatedAt < $1.updatedAt }.reduce(existing) { state, seed in
            merging(seed, into: state)
        }
    }

    static func isActive(_ phase: String) -> Bool {
        activePhases.contains(phase)
    }

    public static func authoritativeRowRetiresSeed(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row,
        seed: TalariaAggregateActivityAttributes.ContentState
    ) -> Bool {
        guard row.id == seed.rows.first?.id else { return false }
        if isActive(row.phase) {
            let isLocalPlaceholder = row.phase == "starting"
                && row.status == String(localized: "Connecting")
                && row.updatedAt == seed.updatedAt
            return !isLocalPlaceholder && row.updatedAt >= seed.updatedAt
        }
        return terminalPhases.contains(row.phase) && row.updatedAt >= seed.updatedAt
    }

    private static let activePhases: Set<String> = [
        "starting", "running", "waiting_for_approval", "waiting_for_input"
    ]
    private static let terminalPhases: Set<String> = ["completed", "failed", "cancelled"]

    private static func displayPriority(_ phase: String) -> Int {
        switch phase {
        case "waiting_for_approval", "waiting_for_input": 0
        case "failed": 1
        case "starting", "running": 2
        default: 3
        }
    }
}

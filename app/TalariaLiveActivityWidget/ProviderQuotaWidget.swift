import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaTimelineEntry: TimelineEntry {
    let date: Date
    let configuration: ProviderQuotaWidgetConfigurationIntent
    let snapshot: ProviderQuotaWidgetSnapshot?

    var relevance: TimelineEntryRelevance? {
        ProviderQuotaWidgetRelevance.relevance(
            snapshot: snapshot,
            configuration: configuration,
            at: date
        )
    }
}

private enum ProviderQuotaWidgetRelevance {
    static func relevance(
        snapshot: ProviderQuotaWidgetSnapshot?,
        configuration: ProviderQuotaWidgetConfigurationIntent,
        at date: Date
    ) -> TimelineEntryRelevance? {
        let sourceIDs = ProviderQuotaWidgetSelection.sourceIDs(
            slotIDs: configuration.sourceIDs,
            capacity: 4
        )
        let sources = ProviderQuotaWidgetSelection.resolve(sourceIDs: sourceIDs, snapshot: snapshot).compactMap { $0 }
        guard !sources.isEmpty else { return nil }

        let settings = ProviderQuotaEvaluationSettings.stored(configuration: configuration)
        let score = sources.map { source in
            let state = ProviderQuotaPresentation.state(for: source, settings: settings, at: date)
            return switch state.urgency {
            case .critical: 100
            case .warning: 70
            case .stale: 20
            case .unavailable: 10
            case .healthy: 0
            }
        }.max() ?? 0
        return score > 0 ? TimelineEntryRelevance(score: Float(score), duration: 15 * 60) : nil
    }
}

struct ProviderQuotaTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ProviderQuotaTimelineEntry {
        ProviderQuotaTimelineEntry(date: Date(), configuration: .init(), snapshot: .preview)
    }

    func snapshot(for configuration: ProviderQuotaWidgetConfigurationIntent, in context: Context) async -> ProviderQuotaTimelineEntry {
        ProviderQuotaTimelineEntry(
            date: Date(),
            configuration: configuration,
            snapshot: ProviderQuotaWidgetSnapshotStore().load() ?? (context.isPreview ? .preview : nil)
        )
    }

    func timeline(for configuration: ProviderQuotaWidgetConfigurationIntent, in context: Context) async -> Timeline<ProviderQuotaTimelineEntry> {
        let now = Date()
        let credentials = ProviderQuotaWidgetRefreshCredentialStore.load()
        if !context.isPreview, let credentials {
            _ = await ProviderQuotaWidgetRefreshClient.refresh(credentials: credentials)
        }
        return Timeline(
            entries: [.init(date: now, configuration: configuration, snapshot: ProviderQuotaWidgetSnapshotStore().load())],
            policy: .after(
                ProviderQuotaWidgetTimelinePolicy.nextRefreshDate(
                    credentials: credentials,
                    now: now
                )
            )
        )
    }
}

struct ProviderQuotaWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: ProviderQuotaWidgetSnapshotStore.widgetKind,
            intent: ProviderQuotaWidgetConfigurationIntent.self,
            provider: ProviderQuotaTimelineProvider()
        ) { entry in
            ProviderQuotaWidgetView(entry: entry)
        }
        .configurationDisplayName("Provider quotas")
        .description("Track quota percentages for explicitly selected providers.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
            .accessoryInline,
            .accessoryCircular,
            .accessoryRectangular,
        ])
    }
}

struct ProviderQuotaPaceWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: ProviderQuotaWidgetSnapshotStore.paceWidgetKind,
            intent: ProviderQuotaWidgetConfigurationIntent.self,
            provider: ProviderQuotaTimelineProvider()
        ) { entry in
            ProviderQuotaPaceWidgetView(entry: entry)
        }
        .configurationDisplayName("Provider quota pace")
        .description("Track pace, burn rate, and depletion forecasts for a provider quota.")
        .supportedFamilies([.accessoryRectangular])
    }
}






private extension ProviderQuotaWidgetSnapshot {
    static var preview: ProviderQuotaWidgetSnapshot {
        ProviderQuotaWidgetSnapshot(
            updatedAt: Date(),
            sources: [
                ProviderQuotaWidgetSource(
                    sourceID: "preview-codex",
                    providerLabel: "Codex",
                    accountLabel: "Work",
                    isActiveProvider: true,
                    status: "available",
                    plan: "Pro",
                    windows: [
                        ProviderQuotaWindow(label: "Session", windowSeconds: 18_000, usedPercent: 24, remainingPercent: 76),
                        ProviderQuotaWindow(label: "Weekly", windowSeconds: 604_800, usedPercent: 51, remainingPercent: 49),
                        ProviderQuotaWindow(label: "Monthly", windowSeconds: 2_592_000, usedPercent: 37, remainingPercent: 63),
                    ],
                    retryAfter: nil,
                    fetchedAt: nil
                )
            ]
        )
    }
}

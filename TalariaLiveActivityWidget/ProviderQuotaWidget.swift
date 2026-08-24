import SwiftUI
import WidgetKit

struct ProviderQuotaTimelineEntry: TimelineEntry {
    let date: Date
    let configuration: ProviderQuotaWidgetConfigurationIntent
    let snapshot: ProviderQuotaWidgetSnapshot?
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
        return Timeline(
            entries: [.init(date: now, configuration: configuration, snapshot: ProviderQuotaWidgetSnapshotStore().load())],
            policy: .after(now.addingTimeInterval(15 * 60))
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
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Provider quotas")
        .description("Track explicitly selected provider accounts and reset windows.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct ProviderQuotaWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ProviderQuotaTimelineEntry

    private var capacity: Int {
        switch family {
        case .systemSmall: 1
        case .systemMedium: 2
        case .systemLarge: 4
        default: 1
        }
    }

    private var sourceIDs: [String] {
        ProviderQuotaWidgetSelection.sourceIDs(slotIDs: entry.configuration.sourceIDs, capacity: capacity)
    }

    private var resolvedSources: [ProviderQuotaWidgetSource?] {
        ProviderQuotaWidgetSelection.resolve(sourceIDs: sourceIDs, snapshot: entry.snapshot)
    }

    private var freshnessDate: Date? {
        resolvedSources.compactMap { $0?.cachedAt }.min()
    }

    private var isStale: Bool {
        guard let freshnessDate else { return false }
        return entry.date.timeIntervalSince(freshnessDate) > ProviderQuotaWidgetSnapshot.staleAfter
    }

    private var smallWidgetURL: URL? {
        guard family == .systemSmall,
              let candidate = resolvedSources.first,
              let source = candidate
        else { return nil }
        return TalariaDeepLink.quotaSourceURL(sourceID: source.sourceID)
    }

    var body: some View {
        Group {
            if sourceIDs.isEmpty {
                ProviderQuotaWidgetPrompt(title: "Configure quotas", detail: "Choose accounts in Edit Widget.", systemImage: "slider.horizontal.3")
            } else if entry.snapshot == nil {
                ProviderQuotaWidgetPrompt(title: "Open Talaria", detail: "Refresh Provider quotas to load widget data.", systemImage: "arrow.clockwise")
            } else {
                VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 7) {
                    HStack {
                        Text("Talaria quotas")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        if isStale {
                            Text("Stale")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.orange)
                        }
                    }

                    sourceGrid

                    if let updatedAt = freshnessDate {
                        Text("Updated \(updatedAt, style: .relative)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .widgetURL(smallWidgetURL)
    }

    @ViewBuilder
    private var sourceGrid: some View {
        if family == .systemSmall {
            sourceCell(at: 0)
        } else {
            LazyVGrid(
                columns: [GridItem(.flexible()), GridItem(.flexible())],
                alignment: .leading,
                spacing: family == .systemLarge ? 8 : 6
            ) {
                ForEach(sourceIDs.indices, id: \.self) { index in
                    sourceCell(at: index)
                }
            }
        }
    }

    @ViewBuilder
    private func sourceCell(at index: Int) -> some View {
        let sourceID = sourceIDs[index]
        if let source = resolvedSources[index], let url = TalariaDeepLink.quotaSourceURL(sourceID: sourceID) {
            Link(destination: url) {
                ProviderQuotaWidgetSourceView(source: source, compact: family != .systemSmall)
            }
            .buttonStyle(.plain)
        } else {
            ProviderQuotaWidgetPrompt(
                title: "Account removed",
                detail: "Edit this widget to choose another source.",
                systemImage: "person.crop.circle.badge.xmark"
            )
        }
    }
}

private struct ProviderQuotaWidgetSourceView: View {
    let source: ProviderQuotaWidgetSource
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(source.accountLabel)
                        .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Text(source.providerLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 3)
                Image(systemName: statusSymbol)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .widgetAccentable()
                    .accessibilityLabel(statusLabel)
            }

            if source.windows.isEmpty, let quota = source.quota {
                ProviderQuotaWidgetAmountView(quota: quota)
            } else if source.windows.isEmpty {
                Text(statusLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                ForEach(Array(source.windows.prefix(2).enumerated()), id: \.offset) { _, window in
                    ProviderQuotaWidgetWindowView(window: window, compact: compact)
                }
            }

            if let retryAt = ProviderQuotaDateParser.date(from: source.retryAfter) {
                Text("Retry \(retryAt, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
            }
        }
        .padding(compact ? 7 : 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var statusLabel: String {
        ProviderQuotaPresentation.statusLabel(source.status)
    }

    private var statusSymbol: String {
        switch source.status {
        case "available": "checkmark.circle.fill"
        case "exhausted": "exclamationmark.circle.fill"
        case "removed": "person.crop.circle.badge.xmark"
        case "invalid_key", "no_key", "dead": "key.slash.fill"
        default: "questionmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch source.status {
        case "available": .green
        case "exhausted", "invalid_key", "dead": .red
        default: .orange
        }
    }

}

private struct ProviderQuotaWidgetWindowView: View {
    let window: ProviderQuotaWindow
    let compact: Bool

    private var used: Double? {
        ProviderQuotaPresentation.usedPercent(window)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(window.label).lineLimit(1)
                Spacer(minLength: 2)
                if let used {
                    Text(used, format: .percent.scale(1).precision(.fractionLength(0...1)))
                        .monospacedDigit()
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            if let used {
                ProgressView(value: used, total: 100)
                    .tint(used >= 90 ? .red : used >= 75 ? .orange : .accentColor)
                    .widgetAccentable()
            }

            if let reset = ProviderQuotaDateParser.date(from: window.resetAt) {
                Group {
                    if compact {
                        Text("Resets \(reset.formatted(date: .omitted, time: .shortened))")
                    } else {
                        Text("Resets \(reset, style: .relative)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            }
        }
    }

}

private struct ProviderQuotaWidgetAmountView: View {
    let quota: ProviderQuotaAmount

    var body: some View {
        if let usage = quota.usage, let limit = quota.limit, limit > 0 {
            let used = min(max(usage / limit * 100, 0), 100)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Credits")
                    Spacer(minLength: 2)
                    Text(used, format: .percent.scale(1).precision(.fractionLength(0...1)))
                        .monospacedDigit()
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                ProgressView(value: used, total: 100)
                    .widgetAccentable()
            }
        } else if let remaining = quota.limitRemaining {
            Text("\(remaining.formatted()) credits remaining")
                .font(.caption2)
                .foregroundStyle(.secondary)
        } else {
            Text("Credits unavailable")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ProviderQuotaWidgetPrompt: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
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
                        ProviderQuotaWindow(label: "Session", usedPercent: 24, remainingPercent: 76),
                        ProviderQuotaWindow(label: "Weekly", usedPercent: 51, remainingPercent: 49),
                    ],
                    retryAfter: nil,
                    fetchedAt: nil
                )
            ]
        )
    }
}

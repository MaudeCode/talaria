import SwiftUI
import WidgetKit

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
        let requestedInterval = max(
            credentials?.refreshIntervalSeconds ?? ProviderQuotaRefreshInterval.defaultValue.rawValue,
            ProviderQuotaRefreshInterval.fiveMinutes.rawValue
        )
        return Timeline(
            entries: [.init(date: now, configuration: configuration, snapshot: ProviderQuotaWidgetSnapshotStore().load())],
            policy: .after(now.addingTimeInterval(TimeInterval(requestedInterval)))
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

private struct ProviderQuotaPaceWidgetView: View {
    let entry: ProviderQuotaTimelineEntry

    var body: some View {
        Group {
            if let source {
                ProviderQuotaLockScreenPaceView(source: source, referenceDate: entry.date)
            } else {
                Label("Configure quota pace", systemImage: "gauge.with.dots.needle.33percent")
                    .font(.caption)
            }
        }
        .widgetURL(source.flatMap { TalariaDeepLink.quotaSourceURL(sourceID: $0.sourceID) })
        .containerBackground(.clear, for: .widget)
    }

    private var source: ProviderQuotaWidgetSource? {
        let sourceIDs = ProviderQuotaWidgetSelection.sourceIDs(
            slotIDs: entry.configuration.sourceIDs,
            capacity: 1
        )
        return ProviderQuotaWidgetSelection.resolve(sourceIDs: sourceIDs, snapshot: entry.snapshot)
            .first ?? nil
    }
}

private struct ProviderQuotaWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @AppStorage(
        ProviderQuotaWidgetBackground.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var defaultBackgroundRawValue = ProviderQuotaWidgetBackground.defaultValue.rawValue
    @AppStorage(
        ProviderQuotaWidgetBackground.customColorHexKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var customBackgroundColorHex = ProviderQuotaWidgetBackground.defaultCustomColorHex
    @AppStorage(
        ProviderQuotaWidgetBackground.opacityPercentKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var backgroundOpacityPercent = ProviderQuotaWidgetBackground.defaultOpacityPercent
    @AppStorage(
        ProviderQuotaWidgetTapAction.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var defaultTapActionRawValue = ProviderQuotaWidgetTapAction.defaultValue.rawValue
    let entry: ProviderQuotaTimelineEntry

    private var capacity: Int {
        switch family {
        case .systemSmall, .accessoryInline, .accessoryCircular, .accessoryRectangular: 1
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

    private var smallWidgetURL: URL? {
        guard family != .systemMedium,
              family != .systemLarge,
              let candidate = resolvedSources.first,
              let source = candidate
        else { return nil }
        return destinationURL(for: source)
    }

    var body: some View {
        Group {
            if sourceIDs.isEmpty {
                ProviderQuotaWidgetPrompt(title: "Configure quotas", detail: "Choose accounts in Edit Widget.", systemImage: "slider.horizontal.3")
            } else if entry.snapshot == nil {
                ProviderQuotaWidgetPrompt(title: "Open Talaria", detail: "Refresh Provider quotas to load widget data.", systemImage: "arrow.clockwise")
            } else {
                sourceGrid
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .widgetURL(smallWidgetURL)
        .containerBackground(widgetBackground, for: .widget)
    }

    @ViewBuilder
    private var sourceGrid: some View {
        if usesTwoWindowLayout {
            twoWindowGrid
        } else if usesSingleSourceExpandedLayout {
            singleSourceExpandedLayout
        } else if family == .accessoryInline || family == .accessoryCircular || family == .accessoryRectangular {
            accessorySource
        } else if family == .systemSmall {
            sourceCell(at: 0)
        } else {
            ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
                ForEach(sourceIDs.indices, id: \.self) { index in
                    sourceCell(at: index)
                }
            }
        }
    }

    @ViewBuilder
    private var twoWindowGrid: some View {
        if let source = resolvedSources.first ?? nil,
           let url = destinationURL(for: source) {
            ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
                ForEach(Array(source.windows.prefix(2).enumerated()), id: \.offset) { _, window in
                    Link(destination: url) {
                        ProviderQuotaWidgetSourceView(
                            source: source,
                            configuration: entry.configuration,
                            compact: false,
                            referenceDate: Date(),
                            windowOverride: window
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var usesTwoWindowLayout: Bool {
        guard family == .systemMedium || family == .systemLarge,
              evaluationSettings.windowSelection == .automatic,
              sourceIDs.count == 1,
              let source = resolvedSources.first ?? nil
        else { return false }
        return source.windows.count >= 2
    }

    @ViewBuilder
    private var singleSourceExpandedLayout: some View {
        if let source = resolvedSources.first ?? nil,
           let url = destinationURL(for: source) {
            Link(destination: url) {
                ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
                    ProviderQuotaWidgetSourceView(
                        source: source,
                        configuration: entry.configuration,
                        compact: false,
                        referenceDate: Date(),
                        windowOverride: nil
                    )
                    .frame(maxWidth: .infinity)

                    ProviderQuotaForecastView(
                        plan: source.plan,
                        state: ProviderQuotaPresentation.state(
                            for: source,
                            settings: ProviderQuotaEvaluationSettings.stored(configuration: entry.configuration),
                            at: Date()
                        )
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var usesSingleSourceExpandedLayout: Bool {
        (family == .systemMedium || family == .systemLarge) && sourceIDs.count == 1
    }

    private var slotSpacing: CGFloat {
        family == .systemLarge ? 20 : 12
    }

    @ViewBuilder
    private var accessorySource: some View {
        if let source = resolvedSources.first ?? nil {
            ProviderQuotaAccessoryView(source: source, entry: entry, family: family)
        } else {
            Image(systemName: "gauge.open.with.lines.needle.33percent")
        }
    }

    @ViewBuilder
    private func sourceCell(at index: Int) -> some View {
        if let source = resolvedSources[index], let url = destinationURL(for: source) {
            Link(destination: url) {
                ProviderQuotaWidgetSourceView(
                    source: source,
                    configuration: entry.configuration,
                    compact: false,
                    referenceDate: Date(),
                    windowOverride: nil
                )
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

    private var effectiveTapAction: ProviderQuotaWidgetTapAction {
        if resolvedProfile.id != ProviderQuotaWidgetProfileStore.defaultProfileID {
            return ProviderQuotaWidgetTapAction(
                rawValue: resolvedProfile.string(ProviderQuotaWidgetTapAction.storageKey)
            ) ?? .defaultValue
        }
        if entry.configuration.tapAction != .appDefault { return entry.configuration.tapAction }
        return ProviderQuotaWidgetTapAction(rawValue: defaultTapActionRawValue) ?? .defaultValue
    }

    private func destinationURL(for source: ProviderQuotaWidgetSource) -> URL? {
        switch effectiveTapAction {
        case .settings:
            TalariaDeepLink.providerQuotaWidgetSettingsURL
        case .refresh:
            TalariaDeepLink.quotaSourceURL(sourceID: source.sourceID, refresh: true)
        case .openApp:
            TalariaDeepLink.openAppURL
        case .newChatWithProvider:
            source.providerID.flatMap { TalariaDeepLink.newChatWithProviderURL(providerID: $0) }
                ?? TalariaDeepLink.newChatURL
        case .appDefault, .insights:
            TalariaDeepLink.quotaSourceURL(sourceID: source.sourceID)
        }
    }

    private var effectiveBackground: ProviderQuotaWidgetBackground {
        if resolvedProfile.id != ProviderQuotaWidgetProfileStore.defaultProfileID {
            return ProviderQuotaWidgetBackground(
                rawValue: resolvedProfile.string(ProviderQuotaWidgetBackground.storageKey)
            ) ?? .defaultValue
        }
        if entry.configuration.background != .appDefault { return entry.configuration.background }
        return ProviderQuotaWidgetBackground(rawValue: defaultBackgroundRawValue) ?? .defaultValue
    }

    private var resolvedProfile: ProviderQuotaWidgetResolvedProfile {
        ProviderQuotaWidgetResolvedProfile.resolve(
            id: isAccessoryFamily ? nil : entry.configuration.profile?.id
        )
    }

    private var isAccessoryFamily: Bool {
        family == .accessoryInline || family == .accessoryCircular || family == .accessoryRectangular
    }

    private var evaluationSettings: ProviderQuotaEvaluationSettings {
        ProviderQuotaEvaluationSettings.stored(configuration: entry.configuration)
    }

    private var widgetBackground: Color {
        switch effectiveBackground {
        case .appDefault, .system: Color(.secondarySystemBackground)
        case .clear: .clear
        case .tinted: .accentColor.opacity(0.16)
        case .dark: Color(white: 0.08)
        case .light: Color(white: 0.96)
        case .custom:
            ProviderQuotaWidgetColorResolver.color(
                hex: resolvedProfile.string(ProviderQuotaWidgetBackground.customColorHexKey),
                fallback: Color(.secondarySystemBackground)
            )
                .opacity(Double(min(max(resolvedProfile.integer(ProviderQuotaWidgetBackground.opacityPercentKey), 0), 100)) / 100)
        }
    }
}

private struct ProviderQuotaWidgetSourceView: View {
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(ProviderQuotaWidgetStatusText.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var statusTextRawValue = ProviderQuotaWidgetStatusText.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetResetDisplay.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var resetDisplayRawValue = ProviderQuotaWidgetResetDisplay.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var defaultShowsPaceMarker = ProviderQuotaWidgetAppearanceSettings.defaultShowsPaceMarker

    let source: ProviderQuotaWidgetSource
    let configuration: ProviderQuotaWidgetConfigurationIntent
    let compact: Bool
    let referenceDate: Date
    let windowOverride: ProviderQuotaWindow?

    var body: some View {
        ProviderQuotaGaugeView(
            providerID: source.providerID,
            displayName: displayName,
            sourceStatus: source.status,
            state: presentation,
            statusText: statusText,
            resetDisplay: resetDisplay,
            style: ProviderQuotaGaugeStyle(
                arcColor: arcColor,
                trackColor: trackColor.opacity(Double(min(max(resolvedProfile.integer(ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey), 0), 100)) / 100),
                lineWidth: lineWidth,
                showsPaceMarker: showsPaceMarker,
                showsProviderIcon: resolvedProfile.boolean(ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey),
                providerIconStyle: ProviderIconStyle(
                    rawValue: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey)
                ) ?? ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle
            ),
            compact: compact
        )
    }

    private var displayName: String {
        let name = ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
        guard let windowOverride else { return name }
        return "\(name) · \(windowOverride.label)"
    }

    private var presentation: ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(configuration: configuration),
            at: referenceDate,
            windowOverride: windowOverride
        )
    }

    private var statusText: ProviderQuotaWidgetStatusText {
        if resolvedProfile.id != ProviderQuotaWidgetProfileStore.defaultProfileID {
            return ProviderQuotaWidgetStatusText(
                rawValue: resolvedProfile.string(ProviderQuotaWidgetStatusText.storageKey)
            ) ?? .defaultValue
        }
        if configuration.statusText != .appDefault { return configuration.statusText }
        return ProviderQuotaWidgetStatusText(rawValue: statusTextRawValue) ?? .defaultValue
    }

    private var resetDisplay: ProviderQuotaWidgetResetDisplay {
        if resolvedProfile.id != ProviderQuotaWidgetProfileStore.defaultProfileID {
            return ProviderQuotaWidgetResetDisplay(
                rawValue: resolvedProfile.string(ProviderQuotaWidgetResetDisplay.storageKey)
            ) ?? .defaultValue
        }
        if configuration.resetDisplay != .appDefault { return configuration.resetDisplay }
        return ProviderQuotaWidgetResetDisplay(rawValue: resetDisplayRawValue) ?? .defaultValue
    }

    private var resolvedProfile: ProviderQuotaWidgetResolvedProfile {
        ProviderQuotaWidgetResolvedProfile.resolve(id: configuration.profile?.id)
    }

    private var arcColor: Color {
        guard configuredArcColor == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(
                configuredArcColor,
                customHex: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey)
            )
        }
        return ProviderQuotaWidgetPalette.arcColor(
            urgency: presentation.urgency,
            profile: resolvedProfile
        )
    }

    private var trackColor: Color {
        let appDefault = ProviderQuotaWidgetArcColor(
            rawValue: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.trackColorKey)
        )
            ?? ProviderQuotaWidgetAppearanceSettings.defaultTrackColor
        let resolved = resolvedProfile.id == ProviderQuotaWidgetProfileStore.defaultProfileID
            ? configuration.trackColor.resolved(default: appDefault)
            : appDefault
        return resolved == .automatic
            ? .secondary
            : ProviderQuotaWidgetColorResolver.color(
                resolved,
                customHex: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.customTrackColorHexKey)
            )
    }

    private var showsPaceMarker: Bool {
        presentation.settings.colorBasis == .pace
            && (resolvedProfile.id == ProviderQuotaWidgetProfileStore.defaultProfileID
                ? configuration.paceMarker.resolved(default: defaultShowsPaceMarker)
                : resolvedProfile.boolean(ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey))
    }

    private var lineWidth: Double {
        let baseWidth: Double
        switch configuredArcWeight {
        case .thin: baseWidth = compact ? 5 : 7
        case .regular: baseWidth = compact ? 7 : 10
        case .bold: baseWidth = compact ? 10 : 14
        }
        return baseWidth
    }

    private var configuredArcColor: ProviderQuotaWidgetArcColor {
        let profileColor = ProviderQuotaWidgetArcColor(
            rawValue: resolvedProfile.string(ProviderQuotaWidgetArcColor.storageKey)
        ) ?? .defaultValue
        return resolvedProfile.id == ProviderQuotaWidgetProfileStore.defaultProfileID
            ? configuration.gaugeColor.resolved(default: profileColor)
            : profileColor
    }

    private var configuredArcWeight: ProviderQuotaWidgetArcWeight {
        let profileWeight = ProviderQuotaWidgetArcWeight(
            rawValue: resolvedProfile.string(ProviderQuotaWidgetArcWeight.storageKey)
        ) ?? .defaultValue
        return resolvedProfile.id == ProviderQuotaWidgetProfileStore.defaultProfileID
            ? configuration.gaugeWeight.resolved(default: profileWeight)
            : profileWeight
    }

}

private struct ProviderQuotaAccessoryView: View {
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()

    let source: ProviderQuotaWidgetSource
    let entry: ProviderQuotaTimelineEntry
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("\(displayName) \(formattedPercent)")
        case .accessoryCircular:
            Gauge(value: percent ?? 0, in: 0...100) {
                Text(displayName)
            } currentValueLabel: {
                Text(formattedPercent)
                    .font(.caption.weight(.semibold))
                    .minimumScaleFactor(0.7)
            }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
            ProviderQuotaLockScreenPercentageView(source: source, referenceDate: entry.date)
        default:
            EmptyView()
        }
    }

    private var state: ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(),
            at: entry.date
        )
    }

    private var percent: Double? {
        state.percent
    }

    private var formattedPercent: String {
        guard let percent else { return ProviderQuotaPresentation.statusLabel(source.status) }
        return percent.formatted(.percent.scale(1).precision(.fractionLength(0)))
    }

    private var displayName: String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
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

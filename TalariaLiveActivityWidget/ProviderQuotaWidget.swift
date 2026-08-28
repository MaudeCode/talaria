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
        if usesTwoSourceLargeLayout {
            twoSourceLargeGrid
        } else if usesThreeWindowLargeLayout {
            threeWindowLargeGrid
        } else if usesTwoWindowLargeLayout {
            twoWindowLargeGrid
        } else if usesSingleWindowLargeLayout {
            singleWindowLargeGrid
        } else if usesTwoWindowLayout {
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

    private var twoSourceLargeGrid: some View {
        ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
            sourceCell(at: 0)
            sourceInfoCell(at: 0)
            sourceCell(at: 1)
            sourceInfoCell(at: 1)
        }
    }

    private var usesTwoSourceLargeLayout: Bool {
        family == .systemLarge && sourceIDs.count == 2
    }

    @ViewBuilder
    private var threeWindowLargeGrid: some View {
        if let source = resolvedSources.first ?? nil,
           let url = destinationURL(for: source) {
            Link(destination: url) {
                ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
                    ForEach(
                        Array(ProviderQuotaPresentation.displayWindows(from: source.windows).enumerated()),
                        id: \.offset
                    ) { _, window in
                        ProviderQuotaWidgetSourceView(
                            source: source,
                            configuration: entry.configuration,
                            compact: false,
                            referenceDate: Date(),
                            windowOverride: window
                        )
                    }

                    ProviderQuotaForecastView(
                        plan: source.plan,
                        state: ProviderQuotaPresentation.state(
                            for: source,
                            settings: evaluationSettings,
                            at: Date()
                        )
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var usesThreeWindowLargeLayout: Bool {
        guard family == .systemLarge,
              sourceIDs.count == 1,
              let source = resolvedSources.first ?? nil
        else { return false }
        return source.windows.count == 3
    }

    @ViewBuilder
    private var twoWindowLargeGrid: some View {
        if let source = resolvedSources.first ?? nil,
           let url = destinationURL(for: source) {
            let windows = ProviderQuotaPresentation.displayWindows(from: source.windows)
            Link(destination: url) {
                ProviderQuotaWidgetSlotLayout(spacing: slotSpacing) {
                    ProviderQuotaWidgetSourceView(
                        source: source,
                        configuration: entry.configuration,
                        compact: false,
                        referenceDate: Date(),
                        windowOverride: windows[0]
                    )
                    ProviderQuotaForecastView(
                        plan: source.plan,
                        state: presentation(for: source, windowOverride: windows[0])
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    ProviderQuotaWidgetSourceView(
                        source: source,
                        configuration: entry.configuration,
                        compact: false,
                        referenceDate: Date(),
                        windowOverride: windows[1]
                    )
                    ProviderQuotaForecastView(
                        plan: source.plan,
                        state: presentation(for: source, windowOverride: windows[1])
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var usesTwoWindowLargeLayout: Bool {
        guard family == .systemLarge,
              sourceIDs.count == 1,
              let source = resolvedSources.first ?? nil
        else { return false }
        return source.windows.count == 2
    }

    @ViewBuilder
    private var singleWindowLargeGrid: some View {
        if let source = resolvedSources.first ?? nil,
           let url = destinationURL(for: source) {
            Link(destination: url) {
                ProviderQuotaWidgetPrimaryDetailLayout(spacing: slotSpacing) {
                    ProviderQuotaWidgetSourceView(
                        source: source,
                        configuration: entry.configuration,
                        compact: false,
                        referenceDate: Date(),
                        windowOverride: nil
                    )
                    ProviderQuotaForecastView(
                        plan: source.plan,
                        state: presentation(for: source)
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var usesSingleWindowLargeLayout: Bool {
        guard family == .systemLarge,
              sourceIDs.count == 1,
              let source = resolvedSources.first ?? nil
        else { return false }
        return source.windows.count <= 1
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
        return source.windows.count == 2
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

    @ViewBuilder
    private func sourceInfoCell(at index: Int) -> some View {
        if let source = resolvedSources[index], let url = destinationURL(for: source) {
            Link(destination: url) {
                ProviderQuotaForecastView(
                    plan: source.plan,
                    state: presentation(for: source)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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

    private func presentation(
        for source: ProviderQuotaWidgetSource,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: evaluationSettings,
            at: Date(),
            windowOverride: windowOverride
        )
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

    @ViewBuilder
    var body: some View {
        if source.windows.count == 3, windowOverride == nil {
            ProviderQuotaBarsView(
                providerID: source.providerID,
                displayName: displayName,
                periods: periods,
                statusText: statusText,
                resetDisplay: resetDisplay,
                trackColor: trackWithOpacity,
                requestedLineWidth: lineWidth,
                showsPaceMarker: showsPaceMarker,
                showsProviderIcon: showsProviderIcon,
                providerIconStyle: providerIconStyle,
                arcColor: arcColor(for:)
            )
        } else {
            ProviderQuotaGaugeView(
                providerID: source.providerID,
                displayName: displayName,
                sourceStatus: source.status,
                state: presentation,
                statusText: statusText,
                resetDisplay: resetDisplay,
                style: gaugeStyle,
                compact: compact
            )
        }
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

    private var periods: [ProviderQuotaPeriodPresentation] {
        ProviderQuotaPresentation.periods(
            for: source,
            settings: presentation.settings,
            at: referenceDate
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
        arcColor(for: presentation)
    }

    private func arcColor(for state: ProviderQuotaPresentationState) -> Color {
        guard configuredArcColor == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(
                configuredArcColor,
                customHex: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey)
            )
        }
        return ProviderQuotaWidgetPalette.arcColor(
            urgency: state.urgency,
            profile: resolvedProfile
        )
    }

    private var gaugeStyle: ProviderQuotaGaugeStyle {
        ProviderQuotaGaugeStyle(
            arcColor: arcColor,
            trackColor: trackWithOpacity,
            lineWidth: lineWidth,
            showsPaceMarker: showsPaceMarker,
            showsProviderIcon: showsProviderIcon,
            providerIconStyle: providerIconStyle
        )
    }

    private var trackWithOpacity: Color {
        trackColor.opacity(
            Double(min(max(resolvedProfile.integer(ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey), 0), 100)) / 100
        )
    }

    private var showsProviderIcon: Bool {
        resolvedProfile.boolean(ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey)
    }

    private var providerIconStyle: ProviderIconStyle {
        ProviderIconStyle(
            rawValue: resolvedProfile.string(ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey)
        ) ?? ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle
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

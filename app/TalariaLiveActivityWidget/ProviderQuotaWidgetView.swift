import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaWidgetView: View {
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

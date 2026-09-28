import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaWidgetSourceView: View {
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

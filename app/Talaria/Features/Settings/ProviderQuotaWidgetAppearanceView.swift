import SwiftUI
import TalariaKit

private enum ProviderQuotaWidgetPreviewState: String, CaseIterable, Identifiable {
    case healthy
    case warning
    case critical
    case stale
    case unavailable

    var id: String { rawValue }
    var title: String {
        switch self {
        case .healthy: String(localized: "Healthy")
        case .warning: String(localized: "Warning")
        case .critical: String(localized: "Critical")
        case .stale: String(localized: "Stale")
        case .unavailable: String(localized: "Unavailable")
        }
    }
    var systemImage: String {
        switch self {
        case .healthy: "checkmark"
        case .warning: "exclamationmark"
        case .critical: "exclamationmark.triangle.fill"
        case .stale: "clock"
        case .unavailable: "slash.circle"
        }
    }
    var urgency: ProviderQuotaUrgency {
        switch self {
        case .healthy: .healthy
        case .warning: .warning
        case .critical: .critical
        case .stale: .stale
        case .unavailable: .unavailable
        }
    }
}

private enum ProviderQuotaWidgetPreviewFamily: String, CaseIterable, Identifiable {
    case small
    case medium
    case large

    var id: String { rawValue }
    var title: String {
        switch self {
        case .small: String(localized: "Small")
        case .medium: String(localized: "Medium")
        case .large: String(localized: "Large")
        }
    }
    var systemImage: String {
        switch self {
        case .small: "widget.small"
        case .medium: "widget.medium"
        case .large: "widget.large"
        }
    }
}

private enum ProviderQuotaWidgetPreviewSurface: String, CaseIterable, Identifiable {
    case home
    case lockPercentage
    case lockPace

    var id: String { rawValue }
    var title: String {
        switch self {
        case .home: String(localized: "Home")
        case .lockPercentage: String(localized: "Lock %")
        case .lockPace: String(localized: "Lock Pace")
        }
    }
}

struct ProviderQuotaWidgetAppearanceView: View {
    @State private var previewState = ProviderQuotaWidgetPreviewState.healthy
    @State private var previewFamily = ProviderQuotaWidgetPreviewFamily.small
    @State private var previewSourceCount = 1
    @State private var previewWindowCount = 3
    @State private var previewSurface = ProviderQuotaWidgetPreviewSurface.home
    @AppStorage(
        ProviderQuotaWidgetArcColor.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var arcColorRawValue = ProviderQuotaWidgetArcColor.defaultValue.rawValue
    @AppStorage(
        ProviderQuotaWidgetArcWeight.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var arcWeightRawValue = ProviderQuotaWidgetArcWeight.defaultValue.rawValue
    @AppStorage(
        ProviderQuotaWidgetColorBasis.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var colorBasisRawValue = ProviderQuotaWidgetColorBasis.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetStatusText.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var statusTextRawValue = ProviderQuotaWidgetStatusText.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetResetDisplay.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var resetDisplayRawValue = ProviderQuotaWidgetResetDisplay.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var showsPaceMarker = ProviderQuotaWidgetAppearanceSettings.defaultShowsPaceMarker
    @AppStorage(ProviderQuotaLockScreenSettings.showsProviderIconKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var lockScreenShowsProviderIcon = ProviderQuotaLockScreenSettings.defaultShowsProviderIcon
    @AppStorage(ProviderQuotaLockScreenSettings.showsResetKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var lockScreenShowsReset = ProviderQuotaLockScreenSettings.defaultShowsReset
    @AppStorage(ProviderQuotaLockScreenSettings.showsWindowKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var lockScreenShowsWindow = ProviderQuotaLockScreenSettings.defaultShowsWindow
    @AppStorage(ProviderQuotaLockScreenSettings.paceDetailKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var lockScreenPaceDetailRawValue = ProviderQuotaLockScreenPaceDetail.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var showsProviderIcon = ProviderQuotaWidgetAppearanceSettings.defaultShowsProviderIcon
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var providerIconStyleRawValue = ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.trackColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var trackColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultTrackColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var trackOpacityPercent = ProviderQuotaWidgetAppearanceSettings.defaultTrackOpacityPercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customArcColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomArcColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customTrackColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customTrackColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomTrackColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.healthyColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var healthyColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultHealthyColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.warningColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var warningColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultWarningColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.criticalColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var criticalColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultCriticalColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.staleColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var staleColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultStaleColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.unavailableColorKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var unavailableColorRawValue = ProviderQuotaWidgetAppearanceSettings.defaultUnavailableColor.rawValue
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customHealthyColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomHealthyColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customWarningColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomWarningColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customCriticalColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomCriticalColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customStaleColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomStaleColorHex
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customUnavailableColorHex = ProviderQuotaWidgetAppearanceSettings.defaultCustomUnavailableColorHex
    @AppStorage(ProviderQuotaWidgetBackground.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var backgroundRawValue = ProviderQuotaWidgetBackground.defaultValue.rawValue
    @AppStorage(ProviderQuotaWidgetBackground.customColorHexKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var customBackgroundColorHex = ProviderQuotaWidgetBackground.defaultCustomColorHex
    @AppStorage(ProviderQuotaWidgetBackground.opacityPercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var backgroundOpacityPercent = ProviderQuotaWidgetBackground.defaultOpacityPercent
    @AppStorage(ProviderQuotaWidgetTapAction.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var tapActionRawValue = ProviderQuotaWidgetTapAction.defaultValue.rawValue
    @AppStorage(
        ProviderQuotaPercentageMode.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var percentageModeRawValue = ProviderQuotaPercentageMode.defaultValue.rawValue

    var body: some View {
        VStack(spacing: 0) {
            pinnedPreviewPanel
            Divider()

            Form {
                Section("Gauge") {
                Picker("Color", selection: $arcColorRawValue) {
                    ForEach(ProviderQuotaWidgetArcColor.allCases) { color in
                        Text(color.title).tag(color.rawValue)
                    }
                }

                if arcColor == .custom {
                    ColorPicker("Custom Color", selection: HeaderLogoColor.binding($customArcColorHex))
                }

                Picker("Weight", selection: $arcWeightRawValue) {
                    ForEach(ProviderQuotaWidgetArcWeight.allCases) { weight in
                        Text(weight.title).tag(weight.rawValue)
                    }
                }

                if arcColor == .automatic {
                    Picker("Automatic Color", selection: $colorBasisRawValue) {
                        ForEach(ProviderQuotaWidgetColorBasis.allCases) { basis in
                            Text(basis.title).tag(basis.rawValue)
                        }
                    }

                    Toggle("Show Pace Marker", isOn: $showsPaceMarker)
                }
            }

            Section("Labels") {
                Toggle("Provider Icon", isOn: $showsProviderIcon)

                if showsProviderIcon {
                    Picker("Icon Style", selection: $providerIconStyleRawValue) {
                        ForEach(ProviderIconStyle.allCases) { style in
                            Text(style.title).tag(style.rawValue)
                        }
                    }
                }

                Picker("Status", selection: $statusTextRawValue) {
                    ForEach(ProviderQuotaWidgetStatusText.allCases.filter { $0 != .appDefault }) { value in
                        Text(value.title).tag(value.rawValue)
                    }
                }

                Picker("Reset", selection: $resetDisplayRawValue) {
                    ForEach(ProviderQuotaWidgetResetDisplay.allCases.filter { $0 != .appDefault }) { value in
                        Text(value.title).tag(value.rawValue)
                    }
                }
            }

            Section("Lock Screen") {
                Toggle("Provider Icon", isOn: $lockScreenShowsProviderIcon)
                Toggle("Reset Time", isOn: $lockScreenShowsReset)
                Toggle("Quota Window", isOn: $lockScreenShowsWindow)
                Picker("Pace Footer", selection: $lockScreenPaceDetailRawValue) {
                    ForEach(ProviderQuotaLockScreenPaceDetail.allCases) { detail in
                        Text(detail.title).tag(detail.rawValue)
                    }
                }
            }

            Section("Surface") {
                Picker("Track Color", selection: $trackColorRawValue) {
                    ForEach(ProviderQuotaWidgetArcColor.allCases) { color in
                        Text(color.title).tag(color.rawValue)
                    }
                }

                if trackColor == .custom {
                    ColorPicker("Custom Track Color", selection: HeaderLogoColor.binding($customTrackColorHex))
                }

                Stepper("Track Opacity: \(trackOpacityPercent)%", value: $trackOpacityPercent, in: 0...100, step: 5)

                Picker("Background", selection: $backgroundRawValue) {
                    ForEach(ProviderQuotaWidgetBackground.allCases.filter { $0 != .appDefault }) { value in
                        Text(value.title).tag(value.rawValue)
                    }
                }

                if background == .custom {
                    ColorPicker("Custom Background Color", selection: HeaderLogoColor.binding($customBackgroundColorHex))

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Background Opacity")
                            Spacer()
                            Text("\(backgroundOpacityPercent)%")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Slider(value: backgroundOpacityBinding, in: 0...100, step: 1)
                    }
                }
            }

            Section("Behavior") {
                Picker("Tap", selection: $tapActionRawValue) {
                    ForEach(ProviderQuotaWidgetTapAction.allCases.filter { $0 != .appDefault }) { value in
                        Text(value.title).tag(value.rawValue)
                    }
                }
            }

            if arcColor == .automatic {
                ProviderQuotaWidgetAutomaticSettingsSections(
                    healthyColor: $healthyColorRawValue,
                    warningColor: $warningColorRawValue,
                    criticalColor: $criticalColorRawValue,
                    staleColor: $staleColorRawValue,
                    unavailableColor: $unavailableColorRawValue,
                    customHealthyColorHex: $customHealthyColorHex,
                    customWarningColorHex: $customWarningColorHex,
                    customCriticalColorHex: $customCriticalColorHex,
                    customStaleColorHex: $customStaleColorHex,
                    customUnavailableColorHex: $customUnavailableColorHex
                )
            }
        }
        }
        .navigationTitle("Customization")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    ProviderQuotaWidgetProfilesView()
                } label: {
                    Image(systemName: "square.stack.3d.up")
                }
                .accessibilityLabel("Widget Profiles")
            }
        }
        .onChange(of: reloadFingerprint) { reloadWidgets() }
    }

    private var reloadFingerprint: String {
        [
            arcColorRawValue,
            arcWeightRawValue,
            colorBasisRawValue,
            String(showsPaceMarker),
            String(showsProviderIcon),
            providerIconStyleRawValue,
            String(lockScreenShowsProviderIcon),
            String(lockScreenShowsReset),
            String(lockScreenShowsWindow),
            lockScreenPaceDetailRawValue,
            statusTextRawValue,
            resetDisplayRawValue,
            trackColorRawValue,
            String(trackOpacityPercent),
            backgroundRawValue,
            tapActionRawValue,
            customArcColorHex,
            customTrackColorHex,
            customBackgroundColorHex,
            String(backgroundOpacityPercent)
        ].joined(separator: "|")
    }

    private var pinnedPreviewPanel: some View {
        VStack(spacing: 8) {
            Picker("Preview", selection: $previewSurface) {
                ForEach(ProviderQuotaWidgetPreviewSurface.allCases) { surface in
                    Text(surface.title).tag(surface)
                }
            }
            .pickerStyle(.segmented)

            VStack(spacing: 3) {
                Text(previewState.title)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                preview
                    .frame(maxWidth: .infinity, minHeight: max(previewSize.height, 140))
                    .overlay(alignment: .topTrailing) {
                        if previewSurface == .home {
                            sizeSelector
                        }
                    }
            }

            Picker("State", selection: $previewState) {
                ForEach(ProviderQuotaWidgetPreviewState.allCases) { state in
                    Label(state.title, systemImage: state.systemImage)
                        .labelStyle(.iconOnly)
                        .tag(state)
                }
            }
            .pickerStyle(.segmented)

            if previewSurface == .home, previewFamily != .small {
                HStack(spacing: 8) {
                    Text("Sources")
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    Picker("Sources", selection: $previewSourceCount) {
                        ForEach(previewSourceCounts, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }

            if previewSurface == .home, previewFamily == .large, previewSourceCount == 1 {
                HStack(spacing: 8) {
                    Text("Windows")
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    Picker("Windows", selection: $previewWindowCount) {
                        ForEach(1...3, id: \.self) { count in
                            Text("\(count)W").tag(count)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.systemGroupedBackground))
    }

    private var preview: some View {
        ZStack {
            RoundedRectangle(
                cornerRadius: previewSurface == .home ? 34 : 18,
                style: .continuous
            )
                .fill(previewBackground)
            previewContent.padding(previewContentPadding)
        }
        .frame(width: previewBaseSize.width, height: previewBaseSize.height)
        .scaleEffect(previewScale)
        .frame(width: previewSize.width, height: previewSize.height)
        .clipped()
    }

    private var sizeSelector: some View {
        VStack(spacing: 2) {
            ForEach(ProviderQuotaWidgetPreviewFamily.allCases) { family in
                Button {
                    previewFamily = family
                    if !previewSourceCounts.contains(previewSourceCount) {
                        previewSourceCount = previewSourceCounts.last ?? 1
                    }
                } label: {
                    Image(systemName: family.systemImage)
                        .font(.title3)
                        .frame(width: 40, height: 40)
                        .background(
                            previewFamily == family ? Color(.tertiarySystemFill) : .clear,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(family.title)
                .accessibilityAddTraits(previewFamily == family ? .isSelected : [])
            }
        }
        .padding(4)
        .background(
            Color(.secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    @ViewBuilder
    private var previewContent: some View {
        if previewSurface == .lockPercentage {
            ProviderQuotaLockScreenPercentageView(
                source: previewSource(at: 0),
                referenceDate: Date()
            )
        } else if previewSurface == .lockPace {
            ProviderQuotaLockScreenPaceView(
                source: previewSource(at: 0),
                referenceDate: Date()
            )
        } else if previewFamily == .large, previewSourceCount == 2 {
            let first = previewSource(at: 0)
            let second = previewSource(at: 1)
            ProviderQuotaWidgetSlotLayout(spacing: previewSlotSpacing) {
                previewGauge(source: first)
                previewInfo(source: first)
                previewGauge(source: second)
                previewInfo(source: second)
            }
        } else if previewFamily == .large,
                  previewSourceCount == 1,
                  previewSource(at: 0).windows.count == 3 {
            let source = previewSource(at: 0)
            ProviderQuotaWidgetSlotLayout(spacing: previewSlotSpacing) {
                ForEach(
                    Array(ProviderQuotaPresentation.displayWindows(from: source.windows).enumerated()),
                    id: \.offset
                ) { _, window in
                    previewGauge(source: source, windowOverride: window)
                }
                ProviderQuotaForecastView(
                    plan: source.plan,
                    state: previewPresentation(for: source)
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if previewFamily == .large,
                  previewSourceCount == 1,
                  previewSource(at: 0).windows.count == 2 {
            let source = previewSource(at: 0)
            let windows = ProviderQuotaPresentation.displayWindows(from: source.windows)
            ProviderQuotaWidgetSlotLayout(spacing: previewSlotSpacing) {
                previewGauge(source: source, windowOverride: windows[0])
                previewInfo(source: source, windowOverride: windows[0])
                previewGauge(source: source, windowOverride: windows[1])
                previewInfo(source: source, windowOverride: windows[1])
            }
        } else if previewFamily == .large, previewSourceCount == 1 {
            let source = previewSource(at: 0)
            ProviderQuotaWidgetPrimaryDetailLayout(spacing: previewSlotSpacing) {
                previewGauge(source: source)
                previewInfo(source: source)
            }
        } else if previewFamily == .small {
            previewGauge(source: previewSource(at: 0))
        } else if previewSourceCount > 1 {
            ProviderQuotaWidgetSlotLayout(spacing: previewSlotSpacing) {
                ForEach(0..<previewSourceCount, id: \.self) { index in
                    previewGauge(source: previewSource(at: index))
                }
            }
        } else {
            ProviderQuotaWidgetSlotLayout(spacing: previewSlotSpacing) {
                previewGauge(source: previewSource(at: 0))
                ProviderQuotaForecastView(
                    plan: previewSource(at: 0).plan,
                    state: previewPresentation(for: previewSource(at: 0))
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func previewInfo(
        source: ProviderQuotaWidgetSource,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> some View {
        ProviderQuotaForecastView(
            plan: source.plan,
            state: previewPresentation(for: source, windowOverride: windowOverride)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var previewContentPadding: CGFloat {
        guard previewSurface == .home else { return 10 }
        return previewFamily == .small ? 22 : 16
    }

    private var previewSlotSpacing: CGFloat {
        previewFamily == .large ? 20 : 12
    }

    @ViewBuilder
    private func previewGauge(
        source: ProviderQuotaWidgetSource,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> some View {
        let presentation = previewPresentation(for: source, windowOverride: windowOverride)
        let periods = ProviderQuotaPresentation.periods(
            for: source,
            settings: presentation.settings,
            at: Date()
        ).map {
            ProviderQuotaPeriodPresentation(
                id: $0.id,
                shortLabel: $0.shortLabel,
                state: $0.state.withUrgency(previewState.urgency)
            )
        }
        let statusText = ProviderQuotaWidgetStatusText(rawValue: statusTextRawValue) ?? .defaultValue
        let resetDisplay = ProviderQuotaWidgetResetDisplay(rawValue: resetDisplayRawValue) ?? .defaultValue
        let track = previewTrackColor.opacity(Double(trackOpacityPercent) / 100)
        let iconStyle = ProviderIconStyle(rawValue: providerIconStyleRawValue)
            ?? ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle
        let marker = arcColor == .automatic
            && presentation.settings.colorBasis == .pace
            && showsPaceMarker

        if source.windows.count != 3 || windowOverride != nil {
            ProviderQuotaGaugeView(
                providerID: source.providerID,
                displayName: windowOverride.map { "\(source.providerLabel) · \($0.label)" }
                    ?? source.providerLabel,
                sourceStatus: source.status,
                state: presentation,
                statusText: statusText,
                resetDisplay: resetDisplay,
                style: ProviderQuotaGaugeStyle(
                    arcColor: previewColor,
                    trackColor: track,
                    lineWidth: previewLineWidth(compact: false),
                    showsPaceMarker: marker,
                    showsProviderIcon: showsProviderIcon,
                    providerIconStyle: iconStyle
                ),
                compact: false
            )
        } else {
            ProviderQuotaBarsView(
                providerID: source.providerID,
                displayName: source.providerLabel,
                periods: periods,
                statusText: statusText,
                resetDisplay: resetDisplay,
                trackColor: track,
                requestedLineWidth: previewLineWidth(compact: false),
                showsPaceMarker: marker,
                showsProviderIcon: showsProviderIcon,
                providerIconStyle: iconStyle,
                arcColor: { _ in previewColor }
            )
        }
    }

    private var previewSourceCounts: [Int] {
        switch previewFamily {
        case .small: [1]
        case .medium: [1, 2]
        case .large: [1, 2, 3, 4]
        }
    }

    private var arcColor: ProviderQuotaWidgetArcColor {
        ProviderQuotaWidgetArcColor(rawValue: arcColorRawValue) ?? .defaultValue
    }

    private var trackColor: ProviderQuotaWidgetArcColor {
        ProviderQuotaWidgetArcColor(rawValue: trackColorRawValue) ?? .automatic
    }

    private var background: ProviderQuotaWidgetBackground {
        ProviderQuotaWidgetBackground(rawValue: backgroundRawValue) ?? .defaultValue
    }

    private var backgroundOpacityBinding: Binding<Double> {
        Binding(
            get: { Double(backgroundOpacityPercent) },
            set: { backgroundOpacityPercent = Int($0.rounded()) }
        )
    }

    private func previewLineWidth(compact: Bool) -> Double {
        switch ProviderQuotaWidgetArcWeight(rawValue: arcWeightRawValue) ?? .defaultValue {
        case .thin: compact ? 5 : 7
        case .regular: compact ? 7 : 10
        case .bold: compact ? 10 : 14
        }
    }

    private var previewColor: Color {
        guard arcColor == .automatic else {
            return ProviderQuotaWidgetColorResolver.color(arcColor, customHex: customArcColorHex)
        }
        return ProviderQuotaWidgetPalette.arcColor(
            urgency: previewState.urgency,
            profile: ProviderQuotaWidgetResolvedProfile.resolve(id: nil, followsSelectedDefault: false)
        )
    }

    private var previewTrackColor: Color {
        if trackColor == .automatic { return .secondary }
        return ProviderQuotaWidgetColorResolver.color(trackColor, customHex: customTrackColorHex)
    }

    private func previewSource(at index: Int) -> ProviderQuotaWidgetSource {
        let providers = [
            ("openai-codex", "OpenAI Codex"),
            ("gemini", "Gemini"),
            ("anthropic", "Claude"),
            ("qwen", "Qwen"),
        ]
        let provider = providers[min(max(index, 0), providers.count - 1)]
        let usedPercent: Double = switch previewState {
        case .healthy, .stale: 13
        case .warning: 40
        case .critical: 90
        case .unavailable: 0
        }
        // Server-shaped sample pace for the weekly window at each preview state.
        let sample: (paceDelta: Double, burnRate: Double, budget: Double, outcome: ProviderQuotaWindowForecast.Outcome) =
            switch previewState {
            case .healthy, .stale: (-1.1, 1.09, 14.1, .safe)
            case .warning: (-28.1, 3.36, 9.7, .warning)
            case .critical: (-78.1, 7.56, 1.6, .warning)
            case .unavailable: (11.9, 0, 16.2, .safe)
            }
        let now = Date()
        let windows = [
            ProviderQuotaWindow(
                label: "Session",
                windowSeconds: 18_000,
                usedPercent: min(100, usedPercent + 12),
                remainingPercent: max(0, 88 - usedPercent),
                resetAt: ISO8601DateFormatter().string(
                    from: now.addingTimeInterval(4 * 60 * 60)
                )
            ),
            ProviderQuotaWindow(
                label: "Weekly",
                windowSeconds: 604_800,
                usedPercent: usedPercent,
                remainingPercent: 100 - usedPercent,
                resetAt: ISO8601DateFormatter().string(
                    from: now.addingTimeInterval((6 * 24 + 4) * 60 * 60)
                ),
                pace: ProviderQuotaWindowPace(
                    expectedRemainingPercent: 88.1,
                    paceDeltaPercent: sample.paceDelta,
                    burnRate: sample.burnRate,
                    minutesToReset: 8_880,
                    elapsedMinutes: 1_200,
                    validUntil: ISO8601DateFormatter().string(
                        from: now.addingTimeInterval((6 * 24 + 4) * 60 * 60)
                    )
                ),
                forecast: ProviderQuotaWindowForecast(
                    outcome: sample.outcome,
                    budgetUnit: .day,
                    budgetPercent: sample.budget,
                    depletionMarginMinutes: sample.outcome == .warning ? -2_880 : nil
                )
            ),
            ProviderQuotaWindow(
                label: "Monthly",
                windowSeconds: 2_592_000,
                usedPercent: max(0, usedPercent - 7),
                remainingPercent: min(100, 107 - usedPercent),
                resetAt: ISO8601DateFormatter().string(
                    from: now.addingTimeInterval(25 * 24 * 60 * 60)
                )
            ),
        ]
        let windowCount = previewSourceCount > 1 ? 3 : previewWindowCount
        return ProviderQuotaWidgetSource(
            sourceID: "preview-\(provider.0)",
            cachedAt: previewState == .stale ? now.addingTimeInterval(-30 * 60) : now,
            providerID: provider.0,
            providerLabel: provider.1,
            accountLabel: provider.1,
            isActiveProvider: index == 0,
            status: previewState == .unavailable ? "unavailable" : "available",
            plan: "Pro",
            windows: previewState == .unavailable ? [] : Array(windows.prefix(windowCount)),
            retryAfter: nil,
            fetchedAt: nil,
            paceWindowIndex: windowCount > 1 ? 1 : 0,
            sessionWindowIndex: 0,
            weeklyWindowIndex: windowCount > 1 ? 1 : nil
        )
    }

    private func previewPresentation(
        for source: ProviderQuotaWidgetSource,
        windowOverride: ProviderQuotaWindow? = nil
    ) -> ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(followsSelectedDefault: false),
            at: Date(),
            windowOverride: windowOverride
        ).withUrgency(previewState.urgency)
    }

    private var previewSize: CGSize {
        CGSize(
            width: previewTargetWidth,
            height: previewBaseSize.height * previewScale
        )
    }

    private var previewBaseSize: CGSize {
        guard previewSurface == .home else { return CGSize(width: 170, height: 72) }
        return switch previewFamily {
        case .small: CGSize(width: 170, height: 170)
        case .medium: CGSize(width: 338, height: 158)
        case .large: CGSize(width: 338, height: 338)
        }
    }

    private var previewTargetWidth: CGFloat {
        guard previewSurface == .home else { return 270 }
        return switch previewFamily {
        case .small: 210
        case .medium: 275
        case .large: 270
        }
    }

    private var previewScale: CGFloat {
        previewTargetWidth / previewBaseSize.width
    }

    private var previewBackground: Color {
        guard previewSurface == .home else { return Color(.secondarySystemGroupedBackground) }
        return switch background {
        case .appDefault, .system: Color(.secondarySystemBackground)
        case .clear: .clear
        case .tinted: .accentColor.opacity(0.16)
        case .dark: Color(white: 0.08)
        case .light: Color(white: 0.96)
        case .custom:
            ProviderQuotaWidgetColorResolver.color(
                hex: customBackgroundColorHex,
                fallback: Color(.secondarySystemBackground)
            )
                .opacity(Double(backgroundOpacityPercent) / 100)
        }
    }

    private func reloadWidgets() {
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }

}

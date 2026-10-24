import SwiftUI
import TalariaKit

/// The same navigation panel is used by the split column and the compact drawer.
struct AppSidebar<Sessions: View, Actions: ToolbarContent>: View {
    @Binding var searchText: String
    @Bindable var presentation: AppSidebarPresentation
    @Bindable var searchPull: SidebarSearchPull
    let searchUsesBottomBar: Bool
    let isActive: Bool

    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(ProviderQuotaSidebarSettings.detailKey)
    private var quotaDetailRawValue = ProviderQuotaSidebarDetail.defaultValue.rawValue
    @AppStorage(ProviderQuotaSidebarSettings.showsRailKey) private var showsQuotaRail = true
    @AppStorage(ProviderQuotaSidebarSettings.showsMarkerKey) private var showsQuotaMarker = true
    @AppStorage(ProviderQuotaSidebarSettings.showsIconKey) private var showsQuotaIcon = true
    @AppStorage(ProviderQuotaSidebarSettings.colorsByStateKey) private var colorsQuotaByState = true

    let quotaSources: [ProviderQuotaWidgetSource]
    let selectedQuotaSourceID: String?
    let selection: AppSection
    let sectionVisibility: SidebarSectionVisibility
    let select: (SessionListUtilityDestination) -> Void
    let sessions: (AnyView, SidebarSearchPull) -> Sessions
    @ToolbarContentBuilder let actions: (Bool) -> Actions

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if searchPull.isSearchPresented && isActive {
                    SettingsPickerSearchField(
                        text: $searchText,
                        prompt: "Search",
                        clearLabel: "Close search",
                        autofocus: true,
                        onClose: {
                            searchText = ""
                            searchPull.isSearchPresented = false
                        }
                    )
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                sessions(AnyView(destinations), searchPull)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }
            .background(Color(.systemBackground))
            .accessibilityIdentifier("app-sidebar")
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(isActive ? .visible : .hidden, for: .navigationBar, .bottomBar)
            .toolbar {
                if isActive {
                    actions(searchPull.isSearchPresented)
                }
                if isActive && !searchPull.isSearchPresented {
                    if #available(iOS 27.1, *) {
                        ToolbarItem(placement: searchUsesBottomBar ? .bottomBar : .topBarTrailing) {
                            SidebarSearchButton(pull: searchPull)
                        }
                        .axisBehavior(searchUsesBottomBar ? .verticalPreferred : .horizontalOnly)
                        .overflowPriority(.search, includesHorizontal: true)
                    } else {
                        ToolbarItem(placement: searchUsesBottomBar ? .bottomBar : .topBarTrailing) {
                            SidebarSearchButton(pull: searchPull)
                        }
                    }
                }
            }
        }
        .onChange(of: searchPull.isSearchPresented) { searchPull.reset() }
        .onChange(of: presentation.searchRequested) { receiveSearchRequest() }
        .onChange(of: isActive, initial: true) {
            if isActive {
                receiveSearchRequest()
            } else {
                searchPull.reset()
            }
        }
        .onDisappear {
            searchPull.reset()
        }
    }

    private func receiveSearchRequest() {
        guard isActive, presentation.searchRequested else { return }
        presentation.searchRequested = false
        searchPull.isSearchPresented = true
    }

    private var destinations: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                if sectionVisibility.tasks {
                    destinationRow(icon: "LucideCalendarClock", destination: .tasks)
                }
                if sectionVisibility.kanban {
                    destinationRow(icon: "LucideColumns3", destination: .kanban)
                }
                if sectionVisibility.skills {
                    destinationRow(icon: "LucideHammer", destination: .skills)
                }
                if sectionVisibility.memory {
                    destinationRow(icon: "LucideBrain", destination: .memory)
                }
                if sectionVisibility.insights {
                    destinationRow(icon: "LucideChartColumnIncreasing", destination: .insights)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            if !quotaSources.isEmpty {
                SidebarSectionHeader(title: String(localized: "Quotas"), isCompact: true) { EmptyView() }
                VStack(spacing: 0) {
                    ForEach(quotaSources) { quotaRow($0) }
                }
                .padding(.horizontal, 12)
            }
        }
    }

    private func destinationRow(icon: String, destination: SessionListUtilityDestination) -> some View {
        let selected = selection == AppSection(destination)
        return destinationRow(destination: destination, isSelected: selected) {
            SidebarUtilityIcon(assetImage: icon, tint: selected ? .accentColor : .primary, size: 20)
        } label: {
            HStack {
                Text(AppSection(destination)?.title ?? "").font(.body).lineLimit(1)
                Spacer(minLength: 0)
            }
        }
    }

    /// Quotas and destinations share their target, insets and selection treatment.
    private func destinationRow(destination: SessionListUtilityDestination, isSelected: Bool,
                                @ViewBuilder icon: () -> some View,
                                @ViewBuilder label: () -> some View) -> some View {
        Button { select(destination) } label: {
            HStack(spacing: 12) {
                icon()
                label()
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .foregroundStyle(isSelected ? Color.accentColor : .primary)
            .background(isSelected ? Color.accentColor.opacity(0.12) : .clear,
                        in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func quotaRow(_ source: ProviderQuotaWidgetSource) -> some View {
        let options = ProviderQuotaSidebarDisplayOptions(
            detail: ProviderQuotaSidebarDetail(rawValue: quotaDetailRawValue) ?? .defaultValue,
            showsRail: showsQuotaRail,
            requestsPaceMarker: showsQuotaMarker,
            showsIcon: showsQuotaIcon,
            colorsByState: colorsQuotaByState
        )
        let state = ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(),
            at: Date()
        )
        let tint = options.colorsByState
            ? ProviderQuotaWidgetPalette.arcColor(
                urgency: state.urgency,
                profile: ProviderQuotaWidgetResolvedProfile.resolve(id: nil)
            )
            : Color.accentColor
        let detail = ProviderQuotaSidebarPresentation.detail(
            mode: options.detail,
            source: source,
            state: state
        )

        return destinationRow(destination: .providers(source.sourceID),
                              isSelected: selection == .insights && selectedQuotaSourceID == source.sourceID) {
            if options.showsIcon {
                ProviderIconView(
                    providerID: source.providerID,
                    label: providerDisplayName(source),
                    tint: tint,
                    size: 20
                )
            }
        } label: {
            VStack(spacing: 2) {
                HStack {
                    Text(providerDisplayName(source))
                        .font(.body)
                        .lineLimit(1)

                    Spacer(minLength: 8)

                    if let detail {
                        Text(detail)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if options.showsRail, let percent = state.percent {
                    quotaRail(
                        percent: percent,
                        expectedPercent: options.showsPaceMarker ? state.expectedPercent : nil,
                        tint: tint
                    )
                }
            }
        }
        .accessibilityIdentifier("app-sidebar-quota-\(source.sourceID)")
        .accessibilityLabel(
            [providerDisplayName(source), detail, state.paceLabel].compactMap { $0 }.joined(separator: ", ")
        )
    }

    private func quotaRail(percent: Double, expectedPercent: Double?, tint: Color) -> some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(.secondary.opacity(0.18))
                Capsule()
                    .fill(tint)
                    .frame(width: width * min(max(percent, 0), 100) / 100)
                if let expectedPercent {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 1.5, height: 3)
                        .offset(
                            x: min(
                                max(width * min(max(expectedPercent, 0), 100) / 100 - 0.75, 0),
                                max(width - 1.5, 0)
                            )
                        )
                }
            }
        }
        .frame(height: 3)
    }

    private func providerDisplayName(_ source: ProviderQuotaWidgetSource) -> String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }

}

/// Geometry callbacks write here; only the toolbar button reads progress during a pull.
@Observable
final class SidebarSearchPull {
    var text = ""
    var isSearchPresented = false
    private(set) var progress: CGFloat = 0
    @ObservationIgnored private var isInteracting = false

    func update(distance: CGFloat) {
        guard isInteracting, !isSearchPresented else { return }
        progress = min(max(distance / 72, 0), 1)
    }

    func phaseChanged(from oldPhase: ScrollPhase, to newPhase: ScrollPhase, reduceMotion: Bool) -> Bool {
        isInteracting = newPhase == .interacting
        guard oldPhase == .interacting, newPhase == .decelerating || newPhase == .idle else { return false }
        let opensSearch = progress >= 1
        if opensSearch || reduceMotion {
            reset()
        } else {
            withAnimation(.smooth) { reset() }
        }
        return opensSearch
    }

    func reset() {
        isInteracting = false
        progress = 0
    }
}

private struct SidebarSearchButton: View {
    let pull: SidebarSearchPull
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasVerticalBar = false

    var body: some View {
        let isArmed = pull.progress >= 1
        HapticButton(feedbackStyle: .medium) { pull.isSearchPresented = true } label: {
            Group {
                if isArmed && !hasVerticalBar {
                    Label("Search", systemImage: "magnifyingglass")
                        .labelStyle(.titleAndIcon)
                } else {
                    Image(systemName: "magnifyingglass")
                }
            }
            .font(.body)
            .frame(minWidth: 28, minHeight: 28)
            .padding(.horizontal, isArmed && !hasVerticalBar ? 10 : 4)
            .frame(minHeight: 36)
            .foregroundStyle(isArmed ? Color.white : Color.primary)
            .background(isArmed ? Color.accentColor : Color.clear, in: Capsule())
            .overlay {
                if !reduceMotion {
                    Circle()
                        .trim(from: 0, to: pull.progress)
                        .stroke(Color.accentColor, lineWidth: 2)
                        .rotationEffect(.degrees(-90))
                        .frame(width: 34, height: 34)
                        .opacity(isArmed ? 0 : 1)
                        .accessibilityHidden(true)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search")
        .accessibilityIdentifier("sidebar-pull-search")
        .animation(reduceMotion ? nil : .smooth, value: isArmed)
        .onToolbarVerticalEdgeChange { hasVerticalBar = $0 }
    }
}

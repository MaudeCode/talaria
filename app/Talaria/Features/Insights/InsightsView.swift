import SwiftUI
import TalariaKit

struct InsightsView: View {
    let server: URL
    let onAPIError: (Error) -> Void
    let initialQuotaSourceID: String?
    let openProviderSettings: () -> Void
    let quotaViewModel: ProvidersViewModel

    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: InsightsViewModel
    @State private var quotaScrollPosition: String?
    @State private var isShowingQuotaNotice = false
    @AppStorage(ProviderQuotaSidebarSettings.firstSourceKey) private var firstSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaSidebarSettings.secondSourceKey) private var secondSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaVisibilitySettings.storageKey) private var hiddenProviderData = Data()
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(
        ProviderQuotaPercentageMode.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var quotaPercentageModeRawValue = ProviderQuotaPercentageMode.defaultValue.rawValue
    @AppStorage(ProviderQuotaRefreshInterval.storageKey)
    private var quotaRefreshIntervalSeconds = ProviderQuotaRefreshInterval.defaultValue.rawValue

    init(
        server: URL,
        quotaViewModel: ProvidersViewModel? = nil,
        initialQuotaSourceID: String? = nil,
        openProviderSettings: @escaping () -> Void = {},
        onAPIError: @escaping (Error) -> Void
    ) {
        self.server = server
        self.quotaViewModel = quotaViewModel ?? ProvidersViewModel(server: server)
        self.initialQuotaSourceID = initialQuotaSourceID
        self.openProviderSettings = openProviderSettings
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: InsightsViewModel(server: server))
    }

    var body: some View {
        content
            .navigationTitle("Insights")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await refreshAll() }
                    } label: {
                        if isRefreshing {
                            ProgressView()
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(isRefreshing)
                }
            }
            .task(id: viewModel.selectedTimeframe) {
                await loadInsights()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                await loadInsights()
            }
            .task {
                quotaScrollPosition = initialQuotaSourceID
                await refreshPendingWidgetSourceIfNeeded()
            }
            .onChange(of: quotaViewModel.quotaSources.map(\.id)) {
                pruneSidebarQuotaPins()
            }
            // Joins the shared quota schedule while Insights is visible and active:
            // stale rows reconcile on open and foreground return (TAL-273).
            .task(id: "\(quotaRefreshIntervalSeconds)|\(scenePhase == .active)") {
                guard scenePhase == .active else { return }
                await quotaViewModel.refreshQuotasPeriodically(
                    every: ProviderQuotaRefreshInterval.storedValue(quotaRefreshIntervalSeconds).duration
                )
            }
    }

    private var content: some View {
        List {
            providerQuotaSection
            analyticsSections
        }
        .listStyle(.insetGrouped)
        .scrollPosition(id: $quotaScrollPosition)
        .refreshable {
            await refreshAll()
        }
    }

    @ViewBuilder
    private var providerQuotaSection: some View {
        Section {
            if quotaViewModel.isQuotaLoading && quotaViewModel.quotaSources.isEmpty {
                Label("Loading provider quotas…", systemImage: "gauge.with.dots.needle.33percent")
            } else if let error = quotaViewModel.quotaErrorMessage, quotaViewModel.quotaSources.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Could not load provider quotas", systemImage: "exclamationmark.triangle")
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try Again") {
                        Task { await loadQuotas() }
                    }
                }
            } else if quotaViewModel.quotaSources.isEmpty {
                Label("No quota sources reported by this server.", systemImage: "gauge.with.dots.needle.33percent")
            } else if visibleQuotaSources.isEmpty {
                Label("All provider quotas are hidden. Show them again in Settings › Providers.", systemImage: "eye.slash")
            } else {
                ForEach(visibleQuotaSources) { source in
                    ProviderQuotaRow(
                        source: source,
                        displayName: providerDisplayName(source),
                        percentageMode: quotaPercentageMode,
                        isRefreshing: quotaViewModel.refreshingQuotaSourceIDs.contains(source.id),
                        isPinned: isPinnedToSidebar(source.id),
                        canPin: quotaViewModel.hasStableQuotaSources && canPinAnotherSidebarQuota,
                        refresh: { Task { await refreshQuotaSource(source.id) } },
                        togglePin: { toggleSidebarPin(source.id) },
                        hide: { hideProvider(source.providerID) }
                    )
                    .id(source.id)
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    .swipeActions(edge: .trailing) {
                        Button {
                            hideProvider(source.providerID)
                        } label: {
                            Label("Hide", systemImage: "eye.slash")
                        }
                        .tint(.orange)
                    }
                    .contextMenu {
                        Button {
                            hideProvider(source.providerID)
                        } label: {
                            Label("Hide from Insights", systemImage: "eye.slash")
                        }
                    }
                }
            }
        } header: {
            HStack {
                Text("Provider quotas")
                if quotaViewModel.isQuotaLoading, !quotaViewModel.quotaSources.isEmpty {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Refreshing provider quotas")
                }
                Spacer(minLength: 8)
                if !quotaNoticeMessages.isEmpty {
                    Button {
                        isShowingQuotaNotice.toggle()
                    } label: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    .accessibilityLabel("Provider quota warning")
                    .accessibilityHint("Shows quota compatibility or refresh details.")
                    .popover(isPresented: $isShowingQuotaNotice) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(quotaNoticeMessages, id: \.self) { message in
                                Text(message)
                            }
                        }
                        .font(.footnote)
                        .padding(14)
                        .frame(idealWidth: 280, maxWidth: 320, alignment: .leading)
                        .accessibilityIdentifier("provider-quota-warning-details")
                        .presentationCompactAdaptation(.popover)
                    }
                }
                Button(action: openProviderSettings) {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Open provider quota settings")
                Button {
                    Task { await loadQuotas(refresh: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(quotaViewModel.isQuotaLoading)
                .accessibilityLabel("Refresh all provider quotas")
            }
        } footer: {
            Text("Pin up to two accounts to show them above Settings in the sidebar.")
        }
        .accessibilityIdentifier("provider-quota-section")
    }

    @ViewBuilder
    private var analyticsSections: some View {
        if viewModel.isLoading && !viewModel.hasLoadedAnalytics {
            Section("Usage analytics") {
                ProgressView("Loading analytics…")
            }
        } else if let errorMessage = viewModel.errorMessage, !viewModel.hasLoadedAnalytics {
            Section("Usage analytics") {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Could Not Load Analytics", systemImage: "exclamationmark.triangle")
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try Again") {
                        Task { await loadInsights() }
                    }
                }
            }
        } else if !viewModel.hasLoadedAnalytics {
            Section("Usage analytics") {
                Label("No session usage data yet", systemImage: "chart.bar")
                Text("Session usage data will appear here once you have conversations.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
                Picker("Timeframe", selection: $viewModel.selectedTimeframe) {
                    ForEach(AnalyticsTimeframe.allCases) { timeframe in
                        Text(timeframe.pickerTitle).tag(timeframe)
                    }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                Section {
                    AnalyticsCard(title: String(localized: "Sessions"), value: "\(viewModel.sessionCount)", icon: "bubble.left.and.bubble.right", color: .blue)
                    AnalyticsCard(title: String(localized: "Messages"), value: formatTokens(viewModel.totalMessages), icon: "text.bubble", color: .cyan)
                    AnalyticsCard(title: String(localized: "Input Tokens"), value: formatTokens(viewModel.totalInputTokens), icon: "arrow.down.circle", color: .green)
                    AnalyticsCard(title: String(localized: "Output Tokens"), value: formatTokens(viewModel.totalOutputTokens), icon: "arrow.up.circle", color: .orange)
                    AnalyticsCard(title: String(localized: "Total Tokens"), value: formatTokens(viewModel.totalTokens), icon: "sum", color: .purple)
                    AnalyticsCard(title: String(localized: "Estimated Cost"), value: viewModel.estimatedCost.formattedCost(collapsingZeroCents: true), icon: "dollarsign.circle", color: .indigo)

                    if let cacheHitPercent = viewModel.totalCacheHitPercent {
                        AnalyticsCard(title: String(localized: "Cache Hit Rate"), value: formatPercent(cacheHitPercent), icon: "bolt.circle", color: .teal)
                    }

                    if let cacheReadTokens = viewModel.totalCacheReadTokens {
                        AnalyticsCard(title: String(localized: "Cache Read Tokens"), value: formatTokens(cacheReadTokens), icon: "arrow.counterclockwise.circle", color: .mint)
                    }
                } header: {
                    HStack {
                        Text(viewModel.periodTitle)
                        if viewModel.isLoading {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("Refreshing usage analytics")
                        }
                    }
                    .textCase(.uppercase)
                }

                if !viewModel.modelBreakdowns.isEmpty {
                    Section("Models") {
                        ForEach(Array(viewModel.modelBreakdowns.prefix(10).enumerated()), id: \.offset) { _, model in
                            ModelBreakdownRow(model: model)
                        }
                    }
                }

                if !viewModel.recentDailyTokens.isEmpty {
                    Section("Recent Daily Tokens") {
                        ForEach(Array(viewModel.recentDailyTokens.enumerated()), id: \.offset) { _, day in
                            DailyTokenRow(day: day)
                        }
                    }
                }

                if viewModel.peakDay != nil || viewModel.peakHour != nil {
                    Section("Activity") {
                        if let peakDay = viewModel.peakDay {
                            ActivitySummaryRow(
                                icon: "calendar",
                                title: String(localized: "Peak Day"),
                                value: peakDay.day ?? String(localized: "Unknown"),
                                detail: String(localized: "\(peakDay.sessions ?? 0) sessions")
                            )
                        }

                        if let peakHour = viewModel.peakHour {
                            ActivitySummaryRow(
                                icon: "clock",
                                title: String(localized: "Peak Hour"),
                                value: formatHour(peakHour.hour),
                                detail: String(localized: "\(peakHour.sessions ?? 0) sessions")
                            )
                        }
                    }
                }

                Section {
                    Text(viewModel.sourceDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
        }
    }

    private var isRefreshing: Bool {
        viewModel.isLoading || quotaViewModel.isQuotaLoading
    }

    private var hiddenProviderIDs: Set<String> {
        ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: hiddenProviderData)
    }

    private var visibleQuotaSources: [ProviderQuotaSource] {
        quotaViewModel.quotaSources.filter { !hiddenProviderIDs.contains($0.providerID.lowercased()) }
    }

    private var quotaPercentageMode: ProviderQuotaPercentageMode {
        ProviderQuotaPercentageMode(rawValue: quotaPercentageModeRawValue) ?? .defaultValue
    }

    private func providerDisplayName(_ source: ProviderQuotaSource) -> String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }

    private var pinnedSidebarSourceIDs: [String] {
        ProviderQuotaSidebarSettings.sourceIDs(
            first: firstSidebarQuotaSourceID,
            second: secondSidebarQuotaSourceID
        )
    }

    private var canPinAnotherSidebarQuota: Bool {
        pinnedSidebarSourceIDs.count < 2
    }

    private func isPinnedToSidebar(_ sourceID: String) -> Bool {
        pinnedSidebarSourceIDs.contains(sourceID)
    }

    private func toggleSidebarPin(_ sourceID: String) {
        if firstSidebarQuotaSourceID == sourceID {
            firstSidebarQuotaSourceID = secondSidebarQuotaSourceID
            secondSidebarQuotaSourceID = ""
        } else if secondSidebarQuotaSourceID == sourceID {
            secondSidebarQuotaSourceID = ""
        } else if firstSidebarQuotaSourceID.isEmpty {
            firstSidebarQuotaSourceID = sourceID
        } else if secondSidebarQuotaSourceID.isEmpty {
            secondSidebarQuotaSourceID = sourceID
        }
    }

    private func hideProvider(_ providerID: String) {
        hiddenProviderData = ProviderQuotaVisibilitySettings.data(
            bySetting: providerID,
            hidden: true,
            in: hiddenProviderData
        )
    }

    private var quotaNoticeMessages: [String] {
        [
            quotaViewModel.quotaErrorMessage.map {
                String(localized: "Couldn't refresh quotas. Showing the last loaded values. \($0)")
            },
        ].compactMap { $0 }
    }

    private func refreshAll() async {
        await loadQuotas(refresh: true)
        await loadInsights()
    }

    private func refreshQuotaSource(_ sourceID: String) async {
        if quotaViewModel.hasStableQuotaSources {
            await quotaViewModel.refreshQuota(sourceID: sourceID)
        } else {
            await loadQuotas(refresh: true)
        }
    }

    private func refreshPendingWidgetSourceIfNeeded() async {
        let defaults = UserDefaults.standard
        guard let sourceID = defaults.string(forKey: ProviderQuotaWidgetLaunchAction.pendingRefreshSourceKey),
              sourceID == initialQuotaSourceID
        else { return }
        defaults.removeObject(forKey: ProviderQuotaWidgetLaunchAction.pendingRefreshSourceKey)
        await refreshQuotaSource(sourceID)
    }

    private func loadQuotas(refresh: Bool = false) async {
        await quotaViewModel.loadQuotas(refresh: refresh)
        pruneSidebarQuotaPins()
    }

    /// Also runs when the shared periodic refresh changes the source list.
    private func pruneSidebarQuotaPins() {
        guard quotaViewModel.hasStableQuotaSources else { return }
        let currentIDs = Set(quotaViewModel.quotaSources.map(\.id))
        if !firstSidebarQuotaSourceID.isEmpty, !currentIDs.contains(firstSidebarQuotaSourceID) {
            firstSidebarQuotaSourceID = ""
        }
        if !secondSidebarQuotaSourceID.isEmpty, !currentIDs.contains(secondSidebarQuotaSourceID) {
            secondSidebarQuotaSourceID = ""
        }
        if firstSidebarQuotaSourceID.isEmpty, !secondSidebarQuotaSourceID.isEmpty {
            firstSidebarQuotaSourceID = secondSidebarQuotaSourceID
            secondSidebarQuotaSourceID = ""
        }
    }

    private func loadInsights() async {
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func formatHour(_ value: Int?) -> String {
        guard let value else { return String(localized: "Unknown") }
        return "\(String(format: "%02d", value)):00"
    }

    private func formatPercent(_ value: Double) -> String {
        insightsFormattedPercent(value)
    }
}

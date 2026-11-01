import SwiftUI
import TalariaKit

/// The two halves of Insights: provider quota accounts, and the server's usage analytics.
enum InsightsTab: String, CaseIterable, Identifiable {
    case quotas
    case usage

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .quotas: "Quotas"
        case .usage: "Usage"
        }
    }
}

struct InsightsView: View {
    let server: URL
    let onAPIError: (Error) -> Void
    let initialQuotaSourceID: String?
    let openProviderSettings: () -> Void
    let quotaViewModel: ProvidersViewModel
    /// The section item the app pushes above this root; a tile sets it to its account.
    @Binding var selection: SectionItem?

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.divisionRegionGeometry) private var divisionGeometry
    @State private var viewModel: InsightsViewModel
    @State private var tab: InsightsTab = .quotas
    @State private var isShowingQuotaNotice = false
    @State private var dailyMetric: InsightsDailyMetric = .tokens
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
        selection: Binding<SectionItem?> = .constant(nil),
        openProviderSettings: @escaping () -> Void = {},
        onAPIError: @escaping (Error) -> Void
    ) {
        self.server = server
        self.quotaViewModel = quotaViewModel ?? ProvidersViewModel(server: server)
        self.initialQuotaSourceID = initialQuotaSourceID
        self._selection = selection
        self.openProviderSettings = openProviderSettings
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: InsightsViewModel(server: server))
    }

    var body: some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("Section", selection: $tab) {
                    ForEach(InsightsTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.bottom, 8)
                .background(Color(.systemGroupedBackground))
                .accessibilityIdentifier("insights-tabs")
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Insights")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    RefreshToolbarButton(isLoading: isRefreshing) {
                        Task { await refreshAll() }
                    }
                }
                if tab == .quotas {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(action: openProviderSettings) {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Open provider quota settings")
                    }
                    if !quotaNoticeMessages.isEmpty {
                        ToolbarItem(placement: .topBarTrailing) {
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
                    }
                }
            }
            .task(id: viewModel.selectedTimeframe) {
                await loadInsights()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                await loadInsights()
            }
            .task(id: initialQuotaSourceID) {
                if let initialQuotaSourceID {
                    tab = .quotas
                    selection = .quotaSource(id: initialQuotaSourceID)
                }
                await refreshPendingWidgetSourceIfNeeded()
            }
            // Also runs on appearance and when a pin syncs in or a provider is hidden.
            .onChange(
                of: [
                    visibleQuotaSources.map(\.id),
                    [firstSidebarQuotaSourceID, secondSidebarQuotaSourceID],
                    [String(quotaViewModel.hasServerQuotaSources)],
                ],
                initial: true
            ) {
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

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .quotas: quotasTab
        case .usage: usageTab
        }
    }

    // MARK: Quotas

    @ViewBuilder
    private var quotasTab: some View {
        if visibleQuotaSources.isEmpty {
            foldAvoiding(quotaStatus)
        } else {
            // One clock for every row; the countdowns move together once a minute.
            TimelineView(.everyMinute) { context in
                List {
                    ForEach(visibleQuotaSources) { source in
                        ProviderQuotaAccountRow(
                            source: source,
                            scopeID: quotaViewModel.quotaScopeID ?? "",
                            displayName: providerDisplayName(source),
                            percentageMode: ProviderQuotaPercentageMode(rawValue: quotaPercentageModeRawValue) ?? .defaultValue,
                            isRefreshing: quotaViewModel.refreshingQuotaSourceIDs.contains(source.id),
                            referenceDate: context.date,
                            open: { selection = .quotaSource(id: source.id) }
                        )
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
                                Task { await refreshQuotaSource(source.id) }
                            } label: {
                                Label("Refresh", systemImage: "arrow.clockwise")
                            }
                            Button {
                                hideProvider(source.providerID)
                            } label: {
                                Label("Hide from Insights", systemImage: "eye.slash")
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
            .accessibilityIdentifier("provider-quota-section")
            .refreshable {
                await loadQuotas(refresh: true)
            }
        }
    }

    @ViewBuilder
    private var quotaStatus: some View {
        if quotaViewModel.isQuotaLoading && quotaViewModel.quotaSources.isEmpty {
            ProgressView("Loading provider quotas…")
        } else if let error = quotaViewModel.quotaErrorMessage, quotaViewModel.quotaSources.isEmpty {
            ContentUnavailableView {
                Label("Could not load provider quotas", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again") {
                    Task { await loadQuotas() }
                }
            }
        } else if quotaViewModel.quotaSources.isEmpty {
            ContentUnavailableView("No quota sources", systemImage: "gauge.with.dots.needle.33percent", description: Text("This server reports no provider quotas."))
        } else {
            ContentUnavailableView {
                Label("All provider quotas are hidden", systemImage: "eye.slash")
            } actions: {
                Button("Provider Quota Settings", action: openProviderSettings)
            }
        }
    }

    // MARK: Usage

    @ViewBuilder
    private var usageTab: some View {
        if !viewModel.hasLoadedAnalytics {
            foldAvoiding(analyticsStatus)
        } else {
            List {
                analyticsSections
            }
            .listStyle(.insetGrouped)
            .refreshable {
                await loadInsights()
            }
        }
    }

    /// A status state sits in the fold-avoiding pane on an open iPhone Duo (TAL-495).
    @ViewBuilder
    private func foldAvoiding(_ status: some View) -> some View {
        if divisionGeometry?.divisions.isEmpty == false {
            ViewThatFits(in: .vertical) {
                status.padding()
                ScrollView { status.padding() }
            }
            .foldAvoidingPlacement()
        } else {
            status
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var analyticsStatus: some View {
        if viewModel.isLoading {
            ProgressView("Loading analytics…")
        } else if let errorMessage = viewModel.errorMessage {
            ContentUnavailableView {
                Label("Could Not Load Analytics", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await loadInsights() }
                }
            }
        } else {
            ContentUnavailableView("No session usage data yet", systemImage: "chart.bar", description: Text("Session usage data will appear here once you have conversations."))
        }
    }

    @ViewBuilder
    private var analyticsSections: some View {
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
            InsightsStatGrid(stats: summaryStats)
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

        if viewModel.dailyTokens.count > 1 {
            Section("Daily") {
                InsightsDailyChart(days: viewModel.dailyTokens, metric: $dailyMetric)
            }
        }

        if !viewModel.modelBreakdowns.isEmpty {
            Section("Models") {
                ForEach(Array(viewModel.modelBreakdowns.prefix(10).enumerated()), id: \.offset) { _, model in
                    ModelBreakdownRow(model: model)
                }
            }
        }

        if !viewModel.activityByDay.isEmpty {
            Section {
                InsightsActivityChart(
                    categories: InsightsActivityChart.weekdays(viewModel.activityByDay),
                    accessibilityLabel: "Sessions by weekday",
                    summary: InsightsActivitySummary.weekday(viewModel.peakDay),
                    identifier: "insights-weekday-chart"
                )
            } header: {
                activityHeader("By weekday", summary: InsightsActivitySummary.weekday(viewModel.peakDay))
            }
        }

        if !viewModel.activityByHour.isEmpty {
            Section {
                InsightsActivityChart(
                    categories: InsightsActivityChart.hours(viewModel.activityByHour),
                    accessibilityLabel: "Sessions by hour",
                    summary: InsightsActivitySummary.hour(viewModel.peakHour),
                    identifier: "insights-hour-chart"
                )
            } header: {
                activityHeader("By hour", summary: InsightsActivitySummary.hour(viewModel.peakHour))
            }
        }

        Section {
            Text(viewModel.sourceDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func activityHeader(_ title: LocalizedStringKey, summary: String?) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: 8)
            if let summary {
                Text(summary)
                    .textCase(nil)
            }
        }
    }

    private var summaryStats: [InsightsStat] {
        var stats = [
            InsightsStat(id: "sessions", title: String(localized: "Sessions"), value: viewModel.sessionCount.formatted()),
            InsightsStat(id: "messages", title: String(localized: "Messages"), value: viewModel.totalMessages.formatted()),
            InsightsStat(id: "input", title: String(localized: "Input tokens"), value: insightsCompactNumber(viewModel.totalInputTokens), exactValue: formatTokens(viewModel.totalInputTokens)),
            InsightsStat(id: "output", title: String(localized: "Output tokens"), value: insightsCompactNumber(viewModel.totalOutputTokens), exactValue: formatTokens(viewModel.totalOutputTokens)),
            InsightsStat(id: "total", title: String(localized: "Total tokens"), value: insightsCompactNumber(viewModel.totalTokens), exactValue: formatTokens(viewModel.totalTokens)),
            InsightsStat(id: "cost", title: String(localized: "Estimated cost"), value: viewModel.estimatedCost.formattedCost(collapsingZeroCents: true)),
        ]
        if let cacheHitPercent = viewModel.totalCacheHitPercent {
            stats.append(InsightsStat(id: "cache-hit", title: String(localized: "Cache hit rate"), value: insightsFormattedPercent(cacheHitPercent)))
        }
        if let cacheReadTokens = viewModel.totalCacheReadTokens {
            stats.append(InsightsStat(id: "cache-read", title: String(localized: "Cache read tokens"), value: insightsCompactNumber(cacheReadTokens), exactValue: formatTokens(cacheReadTokens)))
        }
        return stats
    }

    // MARK: State

    private var isRefreshing: Bool {
        viewModel.isLoading || quotaViewModel.isQuotaLoading
    }

    private var hiddenProviderIDs: Set<String> {
        ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: hiddenProviderData)
    }

    private var visibleQuotaSources: [ProviderQuotaSource] {
        quotaViewModel.quotaSources.filter { !hiddenProviderIDs.contains($0.providerID.lowercased()) }
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

    /// Releases pins Insights cannot show, so a hidden or vanished source never holds a slot.
    private func pruneSidebarQuotaPins() {
        guard quotaViewModel.hasStableQuotaSources else { return }
        let pinnedIDs = pinnedSidebarSourceIDs
        var keeping = Set(visibleQuotaSources.map(\.id))
        if !quotaViewModel.hasServerQuotaSources {
            // A cached list cannot prove a synced pin's source is gone; only the server's can.
            let cachedIDs = Set(quotaViewModel.quotaSources.map(\.id))
            keeping.formUnion(pinnedIDs.filter { !cachedIDs.contains($0) })
        }
        let kept = ProviderQuotaSidebarSettings.pruned(
            first: firstSidebarQuotaSourceID,
            second: secondSidebarQuotaSourceID,
            keeping: keeping
        )
        if firstSidebarQuotaSourceID != kept.first { firstSidebarQuotaSourceID = kept.first }
        if secondSidebarQuotaSourceID != kept.second { secondSidebarQuotaSourceID = kept.second }
    }

    private func loadInsights() async {
        await viewModel.load()

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}

import SwiftUI

struct InsightsView: View {
    let server: URL
    let onAPIError: (Error) -> Void
    let initialQuotaSourceID: String?
    let openProviderSettings: () -> Void

    @State private var viewModel: InsightsViewModel
    @State private var quotaViewModel: ProvidersViewModel
    @State private var quotaScrollPosition: String?
    @State private var isShowingQuotaNotice = false
    @AppStorage(ProviderQuotaSidebarSettings.firstSourceKey) private var firstSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaSidebarSettings.secondSourceKey) private var secondSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaRefreshInterval.storageKey)
    private var quotaRefreshIntervalSeconds = ProviderQuotaRefreshInterval.defaultValue.rawValue
    @AppStorage(ProviderQuotaVisibilitySettings.storageKey) private var hiddenProviderData = Data()
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(
        ProviderQuotaPercentageMode.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var quotaPercentageModeRawValue = ProviderQuotaPercentageMode.defaultValue.rawValue

    init(
        server: URL,
        initialQuotaSourceID: String? = nil,
        openProviderSettings: @escaping () -> Void = {},
        onAPIError: @escaping (Error) -> Void
    ) {
        self.server = server
        self.initialQuotaSourceID = initialQuotaSourceID
        self.openProviderSettings = openProviderSettings
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: InsightsViewModel(server: server))
        _quotaViewModel = State(initialValue: ProvidersViewModel(server: server))
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
            .task {
                await loadQuotas()
                quotaScrollPosition = initialQuotaSourceID
                await refreshPendingWidgetSourceIfNeeded()
            }
            .task(id: quotaRefreshIntervalSeconds) {
                await quotaViewModel.refreshQuotasPeriodically(
                    every: ProviderQuotaRefreshInterval.storedValue(quotaRefreshIntervalSeconds).duration
                )
            }
            .onDisappear {
                quotaViewModel.cancelLoads()
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
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
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

                if !viewModel.topSessions.isEmpty {
                    Section("Top Sessions") {
                        ForEach(viewModel.topSessions.prefix(10)) { session in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(session.title ?? String(localized: "Untitled Session"))
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                    .lineLimit(1)

                                HStack(spacing: 12) {
                                    let input = session.inputTokens ?? 0
                                    let output = session.outputTokens ?? 0
                                    let total = input + output

                                    Text("\(formatTokens(total)) tokens")
                                        .font(.caption)
                                        .fontWeight(.semibold)
                                        .foregroundStyle(.secondary)

                                    if let cost = session.estimatedCost, cost > 0 {
                                        Text(cost.formattedCost())
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
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
            quotaViewModel.quotaCapabilityMessage,
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

    private func formatTokens(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    private func formatHour(_ value: Int?) -> String {
        guard let value else { return String(localized: "Unknown") }
        return "\(String(format: "%02d", value)):00"
    }

    private func formatPercent(_ value: Double) -> String {
        insightsFormattedPercent(value)
    }
}

private struct ProviderQuotaRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let source: ProviderQuotaSource
    let displayName: String
    let percentageMode: ProviderQuotaPercentageMode
    let isRefreshing: Bool
    let isPinned: Bool
    let canPin: Bool
    let refresh: () -> Void
    let togglePin: () -> Void
    let hide: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    providerTitle
                    HStack(spacing: 8) {
                        badges
                        Spacer(minLength: 4)
                        actionButtons
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    providerTitle
                        .layoutPriority(2)
                    badges
                        .fixedSize()
                    Spacer(minLength: 2)
                    actionButtons
                }
            }

            if !source.windows.isEmpty {
                ForEach(Array(source.windows.enumerated()), id: \.offset) { index, window in
                    quotaWindow(window, showsUpdatedAt: index == source.windows.count - 1)
                }
            } else if let quota = source.quota {
                openRouterQuota(quota)
            } else if source.status != "available" {
                statusLine
            }

            if (!source.windows.isEmpty || source.status != "available"),
               let detail = source.details.first,
               !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let retryAt = ProviderQuotaDateParser.date(from: source.retryAfter) {
                Text("Retry \(retryAt, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            if source.windows.isEmpty,
               let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt) {
                HStack {
                    Spacer(minLength: 0)
                    Text("Updated \(fetchedAt, style: .relative)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .accessibilityIdentifier("provider-quota-source-\(source.id)")
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Hide provider from Insights", hide)
    }

    private var providerTitle: some View {
        Text(displayName)
            .font(.subheadline.weight(.semibold))
            .lineLimit(2)
    }

    private var actionButtons: some View {
        HStack(spacing: -8) {
            Button(action: togglePin) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(!isPinned && (!canPin || source.status == "removed"))
            .accessibilityLabel(isPinned ? "Remove \(displayName) from sidebar" : "Add \(displayName) to sidebar")
            .accessibilityHint(!isPinned && !canPin ? "Remove another pinned quota first." : "")

            Button(action: refresh) {
                if isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                }
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(isRefreshing || source.status == "removed")
            .accessibilityLabel(Text("Refresh quota for \(displayName)"))
        }
    }

    @ViewBuilder
    private var badges: some View {
        if let plan = source.plan, !plan.isEmpty {
            Text(plan)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
        }
        if source.isActiveProvider {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
                .accessibilityLabel("Active provider")
        }
    }

    private func quotaWindow(_ window: ProviderQuotaWindow, showsUpdatedAt: Bool) -> some View {
        let resetAt = ProviderQuotaDateParser.date(from: window.resetAt)
        let updatedAt = showsUpdatedAt ? ProviderQuotaDateParser.date(from: source.fetchedAt) : nil

        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                    .font(.footnote.weight(.medium))
                Spacer(minLength: 8)
                if let percent = ProviderQuotaPresentation.percent(window, mode: percentageMode) {
                    Text(percentageText(percent))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let percent = ProviderQuotaPresentation.percent(window, mode: percentageMode) {
                ProgressView(value: percent, total: 100)
                    .tint(progressTint(percent))
                    .accessibilityValue(Text(percentageText(percent)))
            }

            if resetAt != nil || window.detail?.isEmpty == false || updatedAt != nil {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let resetAt {
                        Text("Resets \(resetAt, style: .relative)")
                    } else if let detail = window.detail, !detail.isEmpty {
                        Text(detail)
                    }

                    Spacer(minLength: 8)

                    if let updatedAt {
                        Text("Updated \(updatedAt, style: .relative)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func openRouterQuota(_ quota: ProviderQuotaAmount) -> some View {
        if let usage = quota.usage, let limit = quota.limit, limit > 0 {
            let used = min(max(usage / limit * 100, 0), 100)
            let percent = percentageMode == .used ? used : 100 - used
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Credits")
                        .font(.footnote.weight(.medium))
                    Spacer(minLength: 8)
                    Text(percentageText(percent))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: percent, total: 100)
                    .tint(progressTint(percent))
            }
            .accessibilityElement(children: .combine)
        } else if let remaining = quota.limitRemaining {
            Text("\(remaining.formatted()) credits remaining")
                .font(.footnote)
        } else {
            statusLine
        }
    }

    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(source.unavailableReason ?? source.message ?? statusLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func percentageText(_ percent: Double) -> String {
        let suffix = percentageMode == .used ? String(localized: "used") : String(localized: "remaining")
        return "\(insightsFormattedPercent(percent)) \(suffix)"
    }

    private func progressTint(_ percent: Double) -> Color {
        if percentageMode == .used {
            return percent >= 90 ? .red : percent >= 75 ? .orange : .accentColor
        }
        return percent <= 10 ? .red : percent <= 25 ? .orange : .accentColor
    }

    private var statusLabel: String {
        ProviderQuotaPresentation.statusLabel(source.status)
    }

    private var statusColor: Color {
        switch source.status {
        case "available": .green
        case "exhausted", "dead", "invalid_key": .red
        case "removed", "unsupported", "no_key": .orange
        default: .secondary
        }
    }
}

private struct AnalyticsCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(color)
                .frame(width: 40, height: 40)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Text(value)
                    .font(.title3)
                    .fontWeight(.semibold)
            }

            Spacer()
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

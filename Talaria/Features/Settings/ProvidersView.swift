import SwiftUI

/// Read-only provider status screen (#26): which providers the server knows
/// about, whether each has a credential (and where it came from), which one is
/// active, and each provider's model catalog. Deliberately carries no write
/// affordances — API-key set/delete stays a server-side operation.
struct ProvidersView: View {
    let server: URL
    let initialQuotaSourceID: String?

    @State private var viewModel: ProvidersViewModel
    @State private var expandedProviderKeys: Set<String> = []
    @State private var quotaScrollPosition: String?

    init(server: URL, initialQuotaSourceID: String? = nil) {
        self.server = server
        self.initialQuotaSourceID = initialQuotaSourceID
        _viewModel = State(initialValue: ProvidersViewModel(server: server))
    }

    var body: some View {
        content
            .navigationTitle("Providers")
            .background(Color(.systemBackground))
            .task {
                await viewModel.load()
                await viewModel.loadQuotas()
                quotaScrollPosition = initialQuotaSourceID
            }
            .refreshable {
                await viewModel.load()
                await viewModel.loadQuotas(refresh: true)
            }
            .onDisappear {
                viewModel.cancelLoads()
            }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                quotaSection
                providersSection
            }
            .padding(.top, 20)
            .padding(.bottom, 44)
        }
        .scrollPosition(id: $quotaScrollPosition)
    }

    @ViewBuilder
    private var quotaSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Provider quotas")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)

                Spacer(minLength: 8)

                Button {
                    Task { await viewModel.loadQuotas(refresh: true) }
                } label: {
                    if viewModel.isQuotaLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .disabled(viewModel.isQuotaLoading)
                .accessibilityLabel("Refresh all provider quotas")
            }

            if let capability = viewModel.quotaCapabilityMessage {
                quotaNotice(capability, color: .orange, systemImage: "info.circle.fill")
            }

            if let error = viewModel.quotaErrorMessage, !viewModel.quotaSources.isEmpty {
                quotaNotice(
                    String(localized: "Couldn't refresh quotas. Showing the last loaded values. \(error)"),
                    color: .orange,
                    systemImage: "exclamationmark.triangle.fill"
                )
            }

            if viewModel.isQuotaLoading && viewModel.quotaSources.isEmpty {
                ProvidersStatusRow(title: String(localized: "Loading provider quotas…"), systemImage: "gauge.with.dots.needle.33percent")
            } else if let error = viewModel.quotaErrorMessage, viewModel.quotaSources.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ProvidersStatusRow(title: String(localized: "Could not load provider quotas"), systemImage: "exclamationmark.triangle")
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Button("Try Again") {
                        Task { await viewModel.loadQuotas() }
                    }
                    .font(.subheadline.weight(.medium))
                }
            } else if viewModel.quotaSources.isEmpty {
                ProvidersStatusRow(title: String(localized: "No quota sources reported by this server."), systemImage: "gauge.with.dots.needle.33percent")
            } else {
                ForEach(Array(viewModel.quotaSources.enumerated()), id: \.element.id) { index, source in
                    if index == 0 || viewModel.quotaSources[index - 1].providerID != source.providerID {
                        Text(source.providerLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                            .padding(.top, index == 0 ? 2 : 8)
                            .accessibilityAddTraits(.isHeader)
                    }

                    ProviderQuotaRow(
                        source: source,
                        isRefreshing: viewModel.refreshingQuotaSourceIDs.contains(source.id),
                        refresh: { Task { await viewModel.refreshQuota(sourceID: source.id) } }
                    )
                    .id(source.id)
                }
            }
        }
        .padding(.horizontal, 16)
        .accessibilityIdentifier("provider-quota-section")
    }

    @ViewBuilder
    private var providersSection: some View {
        if viewModel.isLoading && viewModel.providers.isEmpty {
            ProvidersStatusRow(title: String(localized: "Loading providers…"), systemImage: "key.horizontal")
                .padding(.horizontal, 24)
        } else if let errorMessage = viewModel.errorMessage, viewModel.providers.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ProvidersStatusRow(title: String(localized: "Could not load providers"), systemImage: "exclamationmark.triangle")
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Button("Try Again") {
                    Task { await viewModel.load() }
                }
                .font(.subheadline.weight(.medium))
            }
            .padding(.horizontal, 24)
        } else if viewModel.providers.isEmpty {
            ProvidersStatusRow(title: String(localized: "No providers reported by this server."), systemImage: "key.horizontal")
                .padding(.horizontal, 24)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let errorMessage = viewModel.errorMessage {
                    refreshFailureBanner(detail: errorMessage)
                }

                ForEach(Array(viewModel.providers.enumerated()), id: \.offset) { index, provider in
                    let key = Self.expansionKey(for: provider, at: index)
                    ProviderRow(
                        provider: provider,
                        isActive: viewModel.isActive(provider),
                        isExpanded: expandedProviderKeys.contains(key),
                        toggleExpanded: { toggleExpanded(key) }
                    )
                }

                Text("Provider keys are managed on the server. This screen is read-only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .padding(.horizontal, 4)
            }
            .padding(.horizontal, 16)
        }
    }

    private func quotaNotice(_ text: String, color: Color, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(.primary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color.opacity(0.14)))
            .accessibilityElement(children: .combine)
    }

    /// Shown above cached rows when a pull-to-refresh fails: the list would
    /// otherwise look freshly loaded even though the request errored (#42 review).
    private func refreshFailureBanner(detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)

                Text("Couldn't refresh. Showing previously loaded providers.")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
            }

            Text(verbatim: detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.orange.opacity(0.14))
        )
        .accessibilityElement(children: .combine)
    }

    /// Expansion is keyed by the provider's stable id so refreshes that reorder
    /// the list (the server sorts active-first) keep the right rows expanded;
    /// entries without an id fall back to their position.
    static func expansionKey(for provider: ProviderSummary, at index: Int) -> String {
        if let id = provider.id?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty {
            return id
        }

        return "#\(index)"
    }

    private func toggleExpanded(_ key: String) {
        withAnimation(.snappy(duration: 0.22)) {
            if expandedProviderKeys.contains(key) {
                expandedProviderKeys.remove(key)
            } else {
                expandedProviderKeys.insert(key)
            }
        }
    }
}

private struct ProviderQuotaRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let source: ProviderQuotaSource
    let isRefreshing: Bool
    let refresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        accountTitle
                        Spacer(minLength: 4)
                        refreshButton
                    }
                    HStack(spacing: 8) {
                        badges
                        Spacer(minLength: 0)
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    accountTitle
                    badges
                    Spacer(minLength: 4)
                    refreshButton
                }
            }

            if !source.windows.isEmpty {
                ForEach(Array(source.windows.enumerated()), id: \.offset) { _, window in
                    quotaWindow(window)
                }
            } else if let quota = source.quota {
                openRouterQuota(quota)
            } else {
                statusLine
            }

            if let detail = source.details.first, !detail.isEmpty {
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

            if let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt) {
                Text("Updated \(fetchedAt, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .accessibilityIdentifier("provider-quota-source-\(source.id)")
        .accessibilityElement(children: .contain)
    }

    private var accountTitle: some View {
        Text(source.accountLabel)
            .font(.subheadline.weight(.semibold))
            .lineLimit(2)
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
            Text("Active provider")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.green)
        }
    }

    private var refreshButton: some View {
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
        .accessibilityLabel(Text("Refresh quota for \(source.accountLabel)"))
    }

    private func quotaWindow(_ window: ProviderQuotaWindow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                    .font(.footnote.weight(.medium))

                Spacer(minLength: 8)

                if let percent = ProvidersViewModel.quotaPercentText(window) {
                    Text(percent)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let used = ProvidersViewModel.quotaUsedPercent(window) {
                ProgressView(value: used, total: 100)
                    .tint(used >= 90 ? .red : used >= 75 ? .orange : .accentColor)
                    .accessibilityValue(Text(ProvidersViewModel.quotaPercentText(window) ?? ""))
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let resetAt = ProviderQuotaDateParser.date(from: window.resetAt) {
                    Text("Resets \(resetAt, style: .relative)")
                } else if let detail = window.detail, !detail.isEmpty {
                    Text(detail)
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func openRouterQuota(_ quota: ProviderQuotaAmount) -> some View {
        if let usage = quota.usage, let limit = quota.limit, limit > 0 {
            let used = min(max(usage / limit * 100, 0), 100)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Credits")
                        .font(.footnote.weight(.medium))
                    Spacer(minLength: 8)
                    Text("\(insightsFormattedPercent(used)) used")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: used, total: 100)
                    .tint(used >= 90 ? .red : used >= 75 ? .orange : .accentColor)
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

private struct ProviderRow: View {
    let provider: ProviderSummary
    let isActive: Bool
    let isExpanded: Bool
    let toggleExpanded: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ProvidersViewModel.displayName(for: provider))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                if isActive {
                    Text("Active")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.green.opacity(0.16)))
                        .foregroundStyle(.green)
                }

                Spacer(minLength: 0)

                if let badge = ProvidersViewModel.keySourceBadge(for: provider) {
                    // Technical token (env / OAuth / config) — deliberately not localized.
                    Text(verbatim: badge)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                        .foregroundStyle(.secondary)
                }
            }

            keyStatusLine

            if let authError = ProvidersViewModel.authErrorText(for: provider) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityHidden(true)

                    Text(authError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.leading)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Authentication error: \(authError)"))
            }

            if let models = provider.models, !models.isEmpty {
                modelsDisclosure(models)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    @ViewBuilder
    private var keyStatusLine: some View {
        if let hasKey = provider.hasKey {
            HStack(spacing: 6) {
                Image(systemName: hasKey ? "checkmark.seal.fill" : "key.slash")
                    .font(.caption)
                    .foregroundStyle(hasKey ? Color.green : Color.secondary)
                    .accessibilityHidden(true)

                Text(hasKey ? "Key configured" : "No key")
                    .font(.footnote)
                    .foregroundStyle(hasKey ? Color.primary : Color.secondary)
            }
        }
    }

    @ViewBuilder
    private func modelsDisclosure(_ models: [ProviderModel]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: toggleExpanded) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)

                    Text("Models (\(ProvidersViewModel.modelCount(for: provider)))")
                        .font(.footnote.weight(.medium))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows this provider's model list.")

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(models.enumerated()), id: \.offset) { _, model in
                        if let title = modelTitle(model) {
                            Text(verbatim: title)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let info = ProvidersViewModel.truncatedModelInfo(for: provider) {
                        Text("Showing \(info.shown) of \(info.total) models")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 2)
                    }
                }
                .padding(.leading, 18)
            }
        }
    }

    private func modelTitle(_ model: ProviderModel) -> String? {
        let label = model.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return label
        }

        let id = model.id?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let id, !id.isEmpty {
            return id
        }

        return nil
    }
}

private struct ProvidersStatusRow: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            Spacer(minLength: 0)
        }
        .frame(minHeight: 42)
    }
}

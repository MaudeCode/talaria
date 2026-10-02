import SwiftUI
import TalariaKit

/// Read-only provider status screen (#26): which providers the server knows
/// about, whether each has a credential (and where it came from), which one is
/// active, and each provider's model catalog. Deliberately carries no write
/// affordances — API-key set/delete stays a server-side operation.
struct ProvidersView: View {
    let server: URL

    @State private var viewModel: ProvidersViewModel
    @State private var expandedProviderKeys: Set<String> = []
    @AppStorage(ProviderQuotaVisibilitySettings.storageKey) private var hiddenProviderData = Data()
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @State private var providerPendingRenameID: String?
    @State private var providerRenameText = ""

    init(server: URL) {
        self.server = server
        _viewModel = State(initialValue: ProvidersViewModel(server: server))
    }

    var body: some View {
        content
            .navigationTitle("Providers")
            .background(Color(.systemGroupedBackground))
            .task {
                await viewModel.load()
            }
            .refreshesLive(showsStatus: !viewModel.providers.isEmpty) {
                await viewModel.load()
            }
            .refreshable {
                await viewModel.load()
            }
            .onDisappear {
                viewModel.cancelLoads()
            }
            .alert("Rename Provider", isPresented: renameAlertIsPresented) {
                TextField("Provider name", text: $providerRenameText)
                Button("Cancel", role: .cancel) {
                    providerPendingRenameID = nil
                }
                Button("Save") {
                    saveProviderRename()
                }
            } message: {
                Text("Leave the name empty to restore the server-provided name.")
            }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                providersSection
            }
            .padding(.top, 20)
            .padding(.bottom, 44)
        }
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
                    let providerID = ProvidersViewModel.normalizedProviderID(provider.id)
                    ProviderRow(
                        provider: provider,
                        displayName: providerDisplayName(provider),
                        isActive: viewModel.isActive(provider),
                        isHiddenFromInsights: providerID.map { hiddenProviderIDs.contains($0) } ?? false,
                        canChangeInsightsVisibility: providerID != nil,
                        isExpanded: expandedProviderKeys.contains(key),
                        toggleExpanded: { toggleExpanded(key) },
                        toggleInsightsVisibility: {
                            guard let providerID else { return }
                            toggleInsightsVisibility(providerID)
                        },
                        rename: {
                            guard let providerID else { return }
                            providerPendingRenameID = providerID
                            providerRenameText = providerDisplayName(provider)
                        }
                    )
                }

                Text("Provider keys are managed on the server. Use the eye controls to choose which quotas appear in Insights.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .padding(.horizontal, 4)
            }
            .padding(.horizontal, 16)
        }
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

    private var hiddenProviderIDs: Set<String> {
        ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: hiddenProviderData)
    }

    private func toggleInsightsVisibility(_ providerID: String) {
        hiddenProviderData = ProviderQuotaVisibilitySettings.data(
            bySetting: providerID,
            hidden: !hiddenProviderIDs.contains(providerID),
            in: hiddenProviderData
        )
    }

    private var renameAlertIsPresented: Binding<Bool> {
        Binding(
            get: { providerPendingRenameID != nil },
            set: { if !$0 { providerPendingRenameID = nil } }
        )
    }

    private func providerDisplayName(_ provider: ProviderSummary) -> String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: ProvidersViewModel.normalizedProviderID(provider.id),
            fallback: ProvidersViewModel.displayName(for: provider),
            aliasesData: providerAliasesData
        )
    }

    private func saveProviderRename() {
        guard let providerPendingRenameID else { return }
        providerAliasesData = ProviderQuotaDisplaySettings.data(
            byRenaming: providerPendingRenameID,
            to: providerRenameText,
            in: providerAliasesData
        )
        self.providerPendingRenameID = nil
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }
}

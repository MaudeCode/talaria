import SwiftUI

struct TalariaCompletionBanner: View {
    @State private var store = TalariaCompletionStore.shared
    @State private var showsCompletions = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if !store.completions.isEmpty || store.cursor != nil {
                Button {
                    showsCompletions = true
                } label: {
                    HStack {
                        Image(systemName: "checkmark.circle")
                        Text("Completed runs")
                        if !store.completions.isEmpty { Text(store.completions.count.formatted()).monospacedDigit() }
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .font(.subheadline)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                }
                .accessibilityIdentifier("pending-completions")
                .background(.bar)
            }
        }
        .sheet(isPresented: $showsCompletions) {
            TalariaCompletionsView(store: store)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            repeat {
                if !showsCompletions { await store.refresh() }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            } while !Task.isCancelled
        }
    }
}

private struct TalariaCompletionsView: View {
    @Bindable var store: TalariaCompletionStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let error = store.errorMessage {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(store.completions) { completion in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(completion.row.title).font(.headline)
                        Text("\(completion.row.publisherLabel) · \(completion.status)")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text(Date(timeIntervalSince1970: completion.row.updatedAt / 1_000), format: .dateTime.month().day().hour().minute())
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Acknowledge") {
                            Task {
                                guard let credentials = TalariaRelayConfigurationStore.load() else { return }
                                if await store.acknowledge([completion.id]) {
                                    await AgentLiveActivityManager.shared.reconcileAcknowledgedCompletions([completion], credentials: credentials)
                                    guard TalariaRelayConfigurationStore.load() == credentials else { return }
                                    try? await TalariaAggregateLiveActivityManager.shared.refresh()
                                }
                            }
                        }
                        .disabled(store.isAcknowledging)
                        .accessibilityLabel("Acknowledge \(completion.row.title)")
                    }
                    .padding(.vertical, 4)
                }
                if store.cursor != nil {
                    Button("Load more") { Task { await store.refresh(loadMore: true) } }
                        .disabled(store.isLoading || store.isAcknowledging)
                }
                if store.completions.isEmpty && store.cursor == nil && !store.isLoading {
                    Text("No unacknowledged runs")
                }
            }
            .navigationTitle("Completed runs")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
            .refreshable { await store.refresh() }
        }
    }
}

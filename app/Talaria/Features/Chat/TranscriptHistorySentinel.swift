import SwiftUI

/// Replaces LoadOlderMessagesButton's slot with automatic paging and inline retry.
struct TranscriptHistorySentinel<Content: View>: View {
    let isAvailable: Bool
    let isLoading: Bool
    let isNearTop: Bool
    let pageRevision: Int
    let canPrefetch: @MainActor () -> Bool
    let onLoad: () async -> Bool
    let content: (AnyView) -> Content
    @State private var isRequesting = false
    @State private var failed = false
    @State private var armed = true
    @State private var latestNearTop = false
    @State private var leftDuringRequest = false
    @State private var appearedAgain = false
    @State private var latestPageRevision = 0
    @State private var latestAvailable = false
    @State private var requestGeneration = 0

    var body: some View {
        content(AnyView(indicator))
        // Effects live on the whole content, so paging stays active while its header is virtualized.
        .onAppear { latestAvailable = isAvailable; latestPageRevision = pageRevision; latestNearTop = isNearTop; if isNearTop { request() } }
        .onDisappear { latestNearTop = false }
        .onChange(of: isAvailable) { _, available in
            latestAvailable = available
            requestGeneration += 1
            isRequesting = false
            failed = false
            armed = true
            if available && latestNearTop { request() }
        }
        .onChange(of: isLoading) { _, loading in
            if !loading && latestNearTop { request() }
        }
        .onChange(of: pageRevision) { previous, revision in
            latestPageRevision = revision
            if revision > previous && latestNearTop && !isRequesting {
                armed = true
                request()
            }
        }
        .onChange(of: isNearTop) { _, nearTop in
            latestNearTop = nearTop
            if nearTop {
                if isRequesting && leftDuringRequest { appearedAgain = true }
                request()
            } else if isRequesting {
                leftDuringRequest = true
            } else {
                armed = true
            }
        }
    }

    private var indicator: some View {
        HStack(spacing: 8) {
            if isLoading || isRequesting {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading older messages")
            } else if failed {
                Text("Could Not Load Messages")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button { request(retry: true) } label: {
                    Text("Try Again").frame(minHeight: 44)
                }
                .buttonStyle(.chatTactile(.capsule))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44)
    }

    private func request(retry: Bool = false) {
        guard latestAvailable, !isLoading, !isRequesting, retry || (armed && !failed && canPrefetch()) else { return }
        isRequesting = true
        armed = false
        failed = false
        leftDuringRequest = false
        appearedAgain = false
        let requestedRevision = latestPageRevision
        let generation = requestGeneration
        Task { @MainActor in
            let loaded = await onLoad()
            guard generation == requestGeneration else { return }
            failed = !loaded
            await Task.yield()
            guard generation == requestGeneration else { return }
            armed = !latestNearTop
            isRequesting = false
            if !failed && latestNearTop && (appearedAgain || latestPageRevision > requestedRevision) {
                armed = true
                request()
            }
        }
    }
}

import SwiftUI

/// Replaces LoadOlderMessagesButton's slot with automatic paging and inline retry.
struct TranscriptHistorySentinel: View {
    let isLoading: Bool
    let isNearTop: Bool
    let pageRevision: Int
    let canPrefetch: @MainActor () -> Bool
    let onLoad: () async -> Bool
    @State private var isRequesting = false
    @State private var failed = false
    @State private var armed = true
    @State private var latestNearTop = false
    @State private var leftDuringRequest = false
    @State private var appearedAgain = false
    @State private var latestPageRevision = 0

    var body: some View {
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
        // The eager VStack appears off screen; the existing UIKit observer owns actual viewport visibility.
        .onAppear { latestPageRevision = pageRevision; latestNearTop = isNearTop; if isNearTop { request() } }
        .onDisappear { latestNearTop = false }
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

    private func request(retry: Bool = false) {
        guard !isLoading, !isRequesting, retry || (armed && !failed && canPrefetch()) else { return }
        isRequesting = true
        armed = false
        failed = false
        leftDuringRequest = false
        appearedAgain = false
        let requestedRevision = latestPageRevision
        Task { @MainActor in
            failed = !(await onLoad())
            await Task.yield()
            armed = !latestNearTop
            isRequesting = false
            if !failed && latestNearTop && (appearedAgain || latestPageRevision > requestedRevision) {
                armed = true
                request()
            }
        }
    }
}

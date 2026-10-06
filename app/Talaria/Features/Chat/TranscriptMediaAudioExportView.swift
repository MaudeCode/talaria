import AVFoundation
import AVKit
import SwiftUI
import UIKit
import TalariaKit

struct TranscriptMediaAudioExportView: View {
    let reference: TranscriptMediaReference
    let loadMediaData: () async -> Data?

    @State private var cachedData: Data?
    @State private var exportPayload: FileExportPayload?
    @State private var isExporting = false
    @State private var errorMessage: String?

    init(
        reference: TranscriptMediaReference,
        initialData: Data? = nil,
        loadMediaData: @escaping () async -> Data?
    ) {
        self.reference = reference
        self.loadMediaData = loadMediaData
        _cachedData = State(initialValue: initialData)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            InlineAudioPlayerView(title: reference.displayName) {
                await audioData()
            }
            .frame(maxWidth: 280)

            Button {
                Task { await exportAudio() }
            } label: {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 15, weight: .semibold))
            }
            .buttonStyle(.chatTactile(.icon))
            .disabled(isExporting)
            .accessibilityLabel(String(localized: "Export audio \(reference.displayName)"))
        }
        .accessibilityElement(children: .contain)
        .fileExporter(payload: $exportPayload, errorTitle: "Media Action Failed", errorMessage: $errorMessage)
    }

    private func audioData() async -> Data? {
        if let cachedData {
            return cachedData
        }

        let data = await loadMediaData()
        guard !Task.isCancelled else { return nil }
        cachedData = data
        return data
    }

    private func exportAudio() async {
        isExporting = true
        defer {
            isExporting = false
        }

        guard let data = await audioData() else {
            errorMessage = String(localized: "Could not load media.")
            return
        }

        exportPayload = TranscriptMediaExportSupport.payload(for: reference, data: data, resolvedKind: .audio)
    }
}

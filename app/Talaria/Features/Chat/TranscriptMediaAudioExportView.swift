import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaAudioExportView: View {
    let reference: TranscriptMediaReference
    let loadMediaData: () async -> Data?

    @State private var cachedData: Data?
    @State private var exportDocument = ExportedFileDocument(data: Data())
    @State private var exportContentType = UTType.audio
    @State private var exportFilename = String(localized: "Hermes Media")
    @State private var isFileExporterPresented = false
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
        .fileExporter(
            isPresented: $isFileExporterPresented,
            document: exportDocument,
            contentType: exportContentType,
            defaultFilename: exportFilename
        ) { result in
            if case let .failure(error) = result {
                errorMessage = error.localizedDescription
            }
        }
        .alert(
            "Media Action Failed",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        errorMessage = nil
                    }
                }
            )
        ) {
            Button("OK") {
                errorMessage = nil
            }
        } message: {
            Text(errorMessage ?? "")
        }
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

        let payload = TranscriptMediaExportSupport.payload(for: reference, data: data, resolvedKind: .audio)
        exportDocument = ExportedFileDocument(data: payload.data)
        exportContentType = payload.contentType
        exportFilename = payload.filename
        isFileExporterPresented = true
    }
}

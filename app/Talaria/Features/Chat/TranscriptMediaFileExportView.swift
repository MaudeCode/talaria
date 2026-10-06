import AVFoundation
import AVKit
import SwiftUI
import UIKit
import TalariaKit

struct TranscriptMediaFileExportView: View {
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
        HStack(spacing: 8) {
            Image(systemName: "doc")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color(.secondaryLabel))

            VStack(alignment: .leading, spacing: 2) {
                Text(reference.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text(isExporting
                     ? String(localized: "Loading…")
                     : String(localized: "Tap to download"))
                    .font(.caption2)
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button {
                Task { await exportFile() }
            } label: {
                Image(systemName: "square.and.arrow.down")
                    .font(.system(size: 15, weight: .semibold))
            }
            .buttonStyle(.chatTactile(.icon))
            .disabled(isExporting)
            .accessibilityLabel(String(localized: "Download \(reference.displayName)"))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: 240, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
        )
        .accessibilityElement(children: .contain)
        .fileExporter(payload: $exportPayload, errorTitle: "Download Failed", errorMessage: $errorMessage)
    }

    private func fileData() async -> Data? {
        if let cachedData {
            return cachedData
        }

        let data = await loadMediaData()
        guard !Task.isCancelled else { return nil }
        cachedData = data
        return data
    }

    private func exportFile() async {
        isExporting = true
        defer {
            isExporting = false
        }

        guard let data = await fileData() else {
            errorMessage = String(localized: "Could not load file.")
            return
        }

        exportPayload = TranscriptMediaExportSupport.payload(for: reference, data: data, resolvedKind: .data)
    }
}

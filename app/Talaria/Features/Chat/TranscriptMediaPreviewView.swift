import AVFoundation
import AVKit
import SwiftUI
import UIKit
import TalariaKit

struct TranscriptMediaPreviewView: View {
    let onAPIError: (Error) -> Void

    private let item: TranscriptMediaPreviewItem
    @State private var viewModel: TranscriptMediaPreviewViewModel
    @State private var exportPayload: FileExportPayload?
    @State private var isExportingMedia = false
    @State private var isSavingToPhotos = false
    @State private var saveConfirmationMessage: String?
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    init(
        server: URL,
        item: TranscriptMediaPreviewItem,
        onAPIError: @escaping (Error) -> Void
    ) {
        self.item = item
        self.onAPIError = onAPIError
        _viewModel = State(
            initialValue: TranscriptMediaPreviewViewModel(
                server: server,
                reference: item.reference
            )
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.previewData == nil {
                    ProgressView("Loading media...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage = viewModel.errorMessage, viewModel.previewData == nil {
                    ContentUnavailableView {
                        Label("Could Not Load Media", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again") {
                            Task { await loadMedia(force: true) }
                        }
                    }
                } else if let data = viewModel.previewData, let image = UIImage(data: data) {
                    imageContent(image)
                } else if let videoURL = viewModel.videoFileURL {
                    videoContent(videoURL)
                } else {
                    unavailableContent(String(localized: "Preview is not available for this media."))
                }
            }
            .navigationTitle(item.reference.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    if viewModel.canSaveMediaToPhotos {
                        Button {
                            Task { await saveMediaToPhotos() }
                        } label: {
                            Image(systemName: "photo")
                        }
                        .disabled(exportActionsAreDisabled)
                        .accessibilityLabel("Save media to Photos")
                    }

                    if viewModel.canExportMedia {
                        Button {
                            Task { await exportMedia() }
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .disabled(exportActionsAreDisabled)
                        .accessibilityLabel("Export media")
                    }
                }
            }
            .task {
                await loadMedia()
            }
            .refreshable {
                await loadMedia(force: true)
            }
            .fileExporter(payload: $exportPayload, errorTitle: "Media Action Failed", errorMessage: $errorMessage)
            .messageAlert("Saved", message: $saveConfirmationMessage)
            .onDisappear {
                viewModel.cleanupTemporaryFiles()
            }
        }
        .adaptivePagePresentation()
    }

    private func imageContent(_ image: UIImage) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                mediaHeader

                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(item.reference.accessibilityName)
            }
            .padding()
        }
        .background(Color(.systemBackground))
    }

    private func videoContent(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            mediaHeader

            TranscriptVideoPreviewPlayerView(url: url)
                .frame(maxWidth: .infinity)
                .aspectRatio(16 / 9, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
                )
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.systemBackground))
    }

    private func unavailableContent(_ message: String) -> some View {
        ContentUnavailableView {
            Label("No Preview", systemImage: unavailableIconName)
        } description: {
            VStack(spacing: 8) {
                Text(message)
                Text(item.reference.displayName)
                    .font(.footnote)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private var unavailableIconName: String {
        switch item.reference.mediaKind {
        case .image:
            "photo"
        case .audio:
            "waveform"
        case .video:
            "play.rectangle"
        case .unsupported:
            "doc.questionmark"
        }
    }

    private var mediaHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.reference.displayName)
                .font(.caption)
                .fontDesign(.monospaced)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            if let originalByteCount = viewModel.originalByteCount {
                Text(ByteCountFormatter.string(fromByteCount: Int64(originalByteCount), countStyle: .file))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func loadMedia(force: Bool = false) async {
        await viewModel.load(force: force)
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func exportMedia() async {
        isExportingMedia = true
        defer {
            isExportingMedia = false
        }

        do {
            exportPayload = try await viewModel.exportPayload()
        } catch {
            errorMessage = error.localizedDescription
            onAPIError(error)
        }
    }

    private func saveMediaToPhotos() async {
        isSavingToPhotos = true
        defer {
            isSavingToPhotos = false
        }

        do {
            let payload = try await viewModel.exportPayload()
            if payload.isImage {
                guard UIImage(data: payload.data) != nil else {
                    throw PhotoLibrarySaveError.notImage
                }
                try await PhotoLibrarySaver.saveImageData(payload.data)
            } else if payload.isVideo {
                guard let videoFileURL = viewModel.videoFileURL else {
                    throw PhotoLibrarySaveError.videoFileUnavailable
                }
                try await PhotoLibrarySaver.saveVideoFile(at: videoFileURL)
            } else {
                throw PhotoLibrarySaveError.notPhotosMedia
            }

            saveConfirmationMessage = String(localized: "Media saved to Photos.")
        } catch {
            errorMessage = error.localizedDescription
            onAPIError(error)
        }
    }

    private var exportActionsAreDisabled: Bool {
        viewModel.isLoading || isSavingToPhotos || isExportingMedia
    }
}

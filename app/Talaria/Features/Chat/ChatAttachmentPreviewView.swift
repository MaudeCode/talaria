import SwiftUI
import UIKit
import TalariaKit

struct ChatAttachmentPreviewView: View {
    let onAPIError: (Error) -> Void

    private let item: ChatAttachmentPreviewItem
    @State private var viewModel: ChatAttachmentPreviewViewModel
    @Environment(\.dismiss) private var dismiss

    init(
        session: SessionSummary,
        server: URL,
        item: ChatAttachmentPreviewItem,
        onAPIError: @escaping (Error) -> Void
    ) {
        self.item = item
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: ChatAttachmentPreviewViewModel(session: session, server: server, item: item))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.preview == nil {
                    ProgressView("Loading attachment...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage = viewModel.errorMessage, viewModel.preview == nil {
                    ContentUnavailableView {
                        Label("Could Not Load Attachment", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again") {
                            Task { await loadAttachment(force: true) }
                        }
                    }
                } else if let preview = viewModel.preview {
                    previewContent(preview)
                } else {
                    unavailableContent(String(localized: "Preview is not available for this attachment."))
                }
            }
            .navigationTitle(item.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                await loadAttachment()
            }
            .refreshable {
                await loadAttachment(force: true)
            }
        }
        .adaptivePagePresentation()
    }

    @ViewBuilder
    private func previewContent(_ preview: FilePreviewContent) -> some View {
        switch preview {
        case let .text(file):
            textContent(file)
        case let .image(file):
            imageContent(file)
        case let .audio(data):
            audioContent(data)
        case let .unavailable(message):
            unavailableContent(message)
        }
    }

    private func audioContent(_ data: Data) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                fileHeader

                InlineAudioPlayerView(
                    title: item.displayName,
                    load: { data }
                )
            }
            .padding()
        }
        .background(Color(.systemBackground))
    }

    private func textContent(_ file: FileResponse) -> some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 12) {
                fileHeader

                Text(file.content ?? "")
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
        }
        .background(Color(.systemBackground))
    }

    @ViewBuilder
    private func imageContent(_ file: ImageFilePreview) -> some View {
        if let image = UIImage(data: file.data) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    fileHeader

                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(item.displayName)
                }
                .padding()
            }
            .background(Color(.systemBackground))
        } else {
            unavailableContent(String(localized: "Could not preview this image."))
        }
    }

    private func unavailableContent(_ message: String) -> some View {
        ContentUnavailableView {
            Label("No Preview", systemImage: item.inferredIsImage ? "photo" : "doc.questionmark")
        } description: {
            VStack(spacing: 8) {
                Text(message)
                Text(item.displayPath)
                    .font(.footnote)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private var fileHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.displayPath)
                .font(.caption)
                .fontDesign(.monospaced)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            if let metadataText {
                Text(metadataText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var metadataText: String? {
        var parts: [String] = []

        if let preview = viewModel.preview {
            switch preview {
            case let .text(file):
                if let size = file.size {
                    parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                }
                if let lines = file.lines {
                    parts.append(String(localized: "\(lines) lines"))
                }
            case let .image(file):
                parts.append(ByteCountFormatter.string(fromByteCount: Int64(file.originalByteCount), countStyle: .file))
            case let .audio(data):
                parts.append(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))
            case .unavailable:
                break
            }
        } else if let size = item.size {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }

        if let mime = item.mime?.trimmingCharacters(in: .whitespacesAndNewlines),
           !mime.isEmpty {
            parts.append(mime)
        }

        return parts.isEmpty ? nil : parts.joined(separator: " - ")
    }

    private func loadAttachment(force: Bool = false) async {
        await viewModel.load(force: force)
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}

import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct FilePreviewView: View {
    let onAPIError: (Error) -> Void

    private let entry: WorkspaceEntry
    private let initialLine: Int?
    @State private var viewModel: FilePreviewViewModel
    @State private var selectableText: SelectableTextPresentation?
    @State private var exportDocument = ExportedFileDocument(data: Data())
    @State private var exportContentType = UTType.data
    @State private var exportFilename = String(localized: "Hermes File")
    @State private var isFileExporterPresented = false
    @State private var exportErrorMessage: String?
    @State private var saveConfirmationMessage: String?
    @State private var isSavingToPhotos = false
    @AppStorage(FilePreviewDisplaySettings.wrapsLinesKey) private var wrapsLines = false

    /// `initialLine` is one-based; the source viewer scrolls to it and highlights it.
    init(
        session: SessionSummary,
        server: URL,
        entry: WorkspaceEntry,
        initialLine: Int? = nil,
        onAPIError: @escaping (Error) -> Void
    ) {
        self.entry = entry
        self.initialLine = initialLine
        self.onAPIError = onAPIError
        _viewModel = State(initialValue: FilePreviewViewModel(session: session, server: server, path: entry.path ?? ""))
    }

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.preview == nil {
                ProgressView("Loading file...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage = viewModel.errorMessage, viewModel.preview == nil {
                ContentUnavailableView {
                    Label("Could Not Load File", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try Again") {
                        Task { await loadFile() }
                    }
                }
            } else if let preview = viewModel.preview {
                previewContent(preview)
            } else {
                ContentUnavailableView {
                    Label("No Preview", systemImage: "doc.text.magnifyingglass")
                } description: {
                    Text(displayPath)
                }
            }
        }
        .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.workspace)
        .navigationTitle(displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isSourcePreview {
                    Button {
                        wrapsLines.toggle()
                    } label: {
                        Image(systemName: wrapsLines ? "arrow.turn.down.left" : "arrow.left.and.right")
                    }
                    .accessibilityLabel(wrapsLines ? "Disable code line wrapping" : "Enable code line wrapping")
                }

                if viewModel.canSaveImageToPhotos {
                    Button {
                        Task { await saveImageToPhotos() }
                    } label: {
                        Image(systemName: "photo")
                    }
                    .disabled(exportActionsAreDisabled)
                    .accessibilityLabel("Save image to Photos")
                }

                if viewModel.canExportFile {
                    Button {
                        Task { await exportFile() }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(exportActionsAreDisabled)
                    .accessibilityLabel("Export file")
                }
            }
        }
        .task(id: entry.path) {
            await loadFile()
        }
        .refreshable {
            await loadFile()
        }
        .fileExporter(
            isPresented: $isFileExporterPresented,
            document: exportDocument,
            contentType: exportContentType,
            defaultFilename: exportFilename
        ) { result in
            if case let .failure(error) = result {
                exportErrorMessage = error.localizedDescription
            }
        }
        .fullScreenCover(item: $selectableText) { selection in
            SelectableTextPresentationView(selection: selection)
        }
        .alert(
            "Export Failed",
            isPresented: Binding(
                get: { exportErrorMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        exportErrorMessage = nil
                    }
                }
            )
        ) {
            Button("OK") {
                exportErrorMessage = nil
            }
        } message: {
            Text(exportErrorMessage ?? "")
        }
        .alert(
            "Saved",
            isPresented: Binding(
                get: { saveConfirmationMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        saveConfirmationMessage = nil
                    }
                }
            )
        ) {
            Button("OK") {
                saveConfirmationMessage = nil
            }
        } message: {
            Text(saveConfirmationMessage ?? "")
        }
    }

    @ViewBuilder
    private func previewContent(_ preview: FilePreviewContent) -> some View {
        switch preview {
        case let .text(file) where rendersMarkdown:
            markdownContent(file.content ?? "")
        case let .text(file):
            sourceContent(file)
        case let .image(file):
            imageContent(file)
        case .audio:
            // The workspace file browser never produces audio previews; this
            // arm only keeps the shared `FilePreviewContent` switch exhaustive.
            unavailableContent(String(localized: "Preview is not available for this file type."))
        case let .unavailable(message):
            unavailableContent(message)
        }
    }

    private func unavailableContent(_ message: String) -> some View {
        ContentUnavailableView {
            Label("No Preview", systemImage: "doc.questionmark")
        } description: {
            VStack(spacing: 8) {
                Text(message)
                Text(displayPath)
                    .font(.footnote)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func markdownContent(_ content: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                fileHeader

                MarkdownRenderer(content: content, isStreaming: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
        }
        .contentShape(Rectangle())
        .contextMenu { copyActions(for: content) }
        .background(Color(.systemBackground))
    }

    private func sourceContent(_ file: FileResponse) -> some View {
        let content = file.content ?? ""
        return VStack(alignment: .leading, spacing: 0) {
            fileHeader
                .padding(.horizontal)
                .padding(.vertical, 8)

            Divider()

            SourceFileView(
                content: content,
                path: displayPath,
                serverLanguage: file.language,
                targetLine: initialLine,
                wrapsLines: wrapsLines
            )
        }
        .contentShape(Rectangle())
        .contextMenu { copyActions(for: content) }
        .background(Color(.systemBackground))
    }

    /// Whole-file Copy and the exact multiline Select Text sheet.
    @ViewBuilder
    private func copyActions(for content: String) -> some View {
        Button {
            selectableText = SelectableTextPresentation(
                id: "file-preview:\(displayPath)",
                text: content
            )
        } label: {
            Label("Select Text", systemImage: "text.cursor")
        }

        Button {
            UIPasteboard.general.string = content
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }

    private var isSourcePreview: Bool {
        if case .text = viewModel.preview, !rendersMarkdown {
            return true
        }
        return false
    }

    /// Markdown renders as prose unless a link asked for a line: the rendered
    /// document has no line numbers, so a targeted link uses the source viewer.
    private var rendersMarkdown: Bool {
        guard initialLine == nil, let path = entry.path else { return false }
        return ["md", "markdown", "mdown", "mkd"].contains((path as NSString).pathExtension.lowercased())
    }

    @ViewBuilder
    private func imageContent(_ file: ImageFilePreview) -> some View {
        if let image = file.preparedImage {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    fileHeader

                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel(displayName)
                }
                .padding()
            }
            .background(Color(.systemBackground))
        } else {
            unavailableContent(String(localized: "Could not preview this image."))
        }
    }

    private var fileHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(displayPath)
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

    private var displayName: String {
        let name = entry.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return String(localized: "File")
        }
        return name
    }

    private var displayPath: String {
        let path: String?
        if case let .text(file) = viewModel.preview {
            path = file.path ?? entry.path
        } else {
            path = entry.path
        }

        let trimmedPath = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmedPath, !trimmedPath.isEmpty else {
            return displayName
        }
        return trimmedPath
    }

    private var metadataText: String? {
        var parts: [String] = []

        if case let .text(file) = viewModel.preview, let size = file.size {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        } else if case let .image(file) = viewModel.preview {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(file.originalByteCount), countStyle: .file))
        }

        if case let .text(file) = viewModel.preview, let lines = file.lines {
            parts.append(String(localized: "\(lines) lines"))
        }

        return parts.isEmpty ? nil : parts.joined(separator: " - ")
    }

    private func loadFile() async {
        await viewModel.load(path: entry.path ?? "")
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func exportFile() async {
        do {
            let payload = try await viewModel.exportPayload()
            exportDocument = ExportedFileDocument(data: payload.data)
            exportContentType = payload.contentType
            exportFilename = payload.filename
            isFileExporterPresented = true
        } catch {
            exportErrorMessage = error.localizedDescription
            onAPIError(error)
        }
    }

    private func saveImageToPhotos() async {
        isSavingToPhotos = true
        defer {
            isSavingToPhotos = false
        }

        do {
            let payload = try await viewModel.exportPayload()
            guard payload.isImage else {
                throw PhotoLibrarySaveError.notImage
            }

            try await PhotoLibrarySaver.saveImageData(payload.data)
            saveConfirmationMessage = String(localized: "Image saved to Photos.")
        } catch {
            exportErrorMessage = error.localizedDescription
            onAPIError(error)
        }
    }

    private var exportActionsAreDisabled: Bool {
        viewModel.isExporting || isSavingToPhotos
    }
}

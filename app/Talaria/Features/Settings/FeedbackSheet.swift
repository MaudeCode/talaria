import PhotosUI
import SwiftUI
import TalariaKit
import UIKit
import UniformTypeIdentifiers

/// Uses the same native form presentation as CreateProfileSheet; submission stays in the draft owner.
struct FeedbackSheet: View {
    static var title: String { String(localized: "Send Feedback") }
    static let systemImage = "bubble.and.pencil"
    @Bindable var model: FeedbackComposer
    @State private var diagnosticsExpanded = false
    @State private var confirmNewReport = false
    @State private var pickedItems: [PhotosPickerItem] = []
    /// Its reference URL is the local file the composer staged.
    @State private var previewItem: TranscriptMediaPreviewItem?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: field(\.kind)) {
                        Text("Bug").tag("bug")
                        Text("Feature Request").tag("feature")
                        Text("Other").tag("other")
                    }
                    TextField("Title (optional)", text: field(\.title))
                        .accessibilityIdentifier("feedback-title")
                    TextField("Details", text: field(\.body), axis: .vertical)
                        .lineLimit(5...12)
                        .accessibilityIdentifier("feedback-details")
                    Toggle("Include Diagnostics", isOn: field(\.includeDiagnostics))
                }
                .disabled(model.hasUnknownOutcome)

                if model.attachmentsEnabled || !model.attachments.isEmpty {
                    attachmentSection
                }

                if model.draft.includeDiagnostics {
                    Section {
                        DisclosureGroup("Diagnostics", isExpanded: $diagnosticsExpanded) {
                            if let text = model.diagnosticsText {
                                Text(verbatim: text)
                                    .font(AppFont.caption())
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("feedback-diagnostics")
                            }
                            ForEach(model.diagnosticReports, id: \.self) { report in
                                SettingsInfoRow(title: diagnosticTitle(report.kind), value: diagnosticDetail(report), wrapsValue: true)
                            }
                            if let error = model.diagnosticsError {
                                SettingsErrorFootnote(error)
                                Button("Retry") { Task { await model.loadDiagnostics() } }
                            }
                        }
                    }
                }
                if let error = model.validationError ?? model.error {
                    Section {
                        SettingsErrorFootnote(error)
                        if model.cannotRetryDiagnostics {
                            Button { confirmNewReport = true } label: {
                                Image(systemName: "square.and.pencil")
                            }
                            .accessibilityLabel("Start New Report")
                            .help("Start New Report")
                        }
                    }
                }
            }
            .navigationTitle(Self.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.isPresented = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { model.send() }
                        .disabled(!model.canSend)
                        .accessibilityIdentifier("feedback-send")
                }
            }
            .task(id: diagnosticsExpanded) {
                if diagnosticsExpanded { await model.loadDiagnostics() }
            }
            .task { await model.loadAttachmentOptions() }
            .confirmationDialog("Start a new report?", isPresented: $confirmNewReport) {
                Button("Start New Report", role: .destructive) { model.startNewReportAfterDiagnosticsExpired() }
            } message: {
                Text("The previous report may already have been sent.")
            }
            .sheet(item: $previewItem) { item in
                if let file = URL(string: item.reference.url) {
                    TranscriptMediaPreviewView(localFile: file, item: item)
                }
            }
            .onChange(of: pickedItems) { _, items in
                guard !items.isEmpty else { return }
                pickedItems = []
                Task { await attach(items) }
            }
        }
        .adaptiveFormPresentation()
    }

    private func diagnosticTitle(_ kind: FeedbackDiagnosticReport.Kind) -> String {
        switch kind {
        case .crash: String(localized: "Crash Report")
        case .hang: String(localized: "Hang Report")
        case .cpuException: String(localized: "CPU Exception Report")
        case .diskWrite: String(localized: "Disk Write Report")
        }
    }

    private func diagnosticDetail(_ report: FeedbackDiagnosticReport) -> String {
        let build = String(localized: "Build \(report.build)")
        guard let start = try? Date.ISO8601FormatStyle().parse(report.start),
              let end = try? Date.ISO8601FormatStyle().parse(report.end), start <= end else { return build }
        let window = Date.IntervalFormatStyle(date: .abbreviated, time: .shortened).format(start..<end)
        return "\(window)\n\(build)"
    }

    private var attachmentSection: some View {
        Section {
            if !model.pendingAttachments.isEmpty {
                ComposerAttachmentStripView(
                    photos: model.pendingAttachments,
                    hangsFromCard: false,
                    onRemove: { model.removeAttachment($0) },
                    onPreview: { attachment in
                        previewItem = model.previewReference(of: attachment.id).map(TranscriptMediaPreviewItem.init(reference:))
                    }
                )
                .environment(\.retryPendingAttachment) { model.retryAttachment($0) }
                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
            }
            if model.remainingAttachmentSlots > 0 {
                let videoAllowed = model.videoAllowed
                PhotosPicker(selection: $pickedItems, maxSelectionCount: model.remainingAttachmentSlots,
                             matching: videoAllowed ? .any(of: [.images, .videos]) : .images) {
                    Label(videoAllowed ? "Add Photo or Video" : "Add Photo", systemImage: "photo.on.rectangle")
                }
                .accessibilityIdentifier("feedback-add-attachment")
            }
            if model.attachmentsEnabled {
                PasteButton(supportedContentTypes: [.image]) { providers in
                    Task { await attachImages(from: providers) }
                }
                .accessibilityIdentifier("feedback-paste-attachment")
            }
            if let error = model.attachmentError {
                SettingsErrorFootnote(error)
            }
        }
        .disabled(model.hasUnknownOutcome)
    }

    private func attachImages(from providers: [NSItemProvider]) async {
        guard model.checkAttachmentCapacity(providers.count) else { return }
        var images: [Data] = []
        for provider in providers {
            let data: Data? = await withCheckedContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    continuation.resume(returning: data)
                }
            }
            if let data { images.append(data) }
        }
        // The user may have picked another photo while the providers were loading.
        guard model.checkAttachmentCapacity(images.count) else { return }
        for data in images { model.addImage(data) }
        if images.count != providers.count { model.reportUnloadableAttachment() }
    }

    /// Videos arrive as a temporary file copy, removed once compressed; photos arrive as data.
    func attach(_ items: [PhotosPickerItem]) async {
        var loadFailed = false
        for item in items {
            let isMovie = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            if isMovie, let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                await model.addVideo(at: movie.url)?.value
                try? FileManager.default.removeItem(at: movie.url)
            } else if !isMovie, let data = try? await item.loadTransferable(type: Data.self) {
                model.addImage(data)
            } else {
                loadFailed = true
            }
        }
        // After the loop, because adding a later item clears the attachment error.
        if loadFailed { model.reportUnloadableAttachment() }
    }

    private func field<Value>(_ path: WritableKeyPath<FeedbackRequest, Value>) -> Binding<Value> {
        Binding(get: { model.draft[keyPath: path] }, set: { value in model.edit { $0[keyPath: path] = value } })
    }
}

private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("feedback-\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

extension View {
    func feedbackPresentation(_ model: FeedbackComposer?, isEnabled: Bool = true) -> some View {
        sheet(isPresented: Binding(get: { isEnabled && model?.isPresented == true }, set: { value in
            if isEnabled { model?.isPresented = value }
        })) {
            if let model { FeedbackSheet(model: model) }
        }
        .overlay(alignment: .top) {
            if isEnabled, let model { GitActionToastOverlay(state: model.confirmation) }
        }
    }
}

private extension UIApplication {
    /// The key window as it last appeared on screen, before any pending update draws.
    func keyWindowPNG() -> Data? {
        guard let window = connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)
        else { return nil }
        return UIGraphicsImageRenderer(bounds: window.bounds).pngData { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
    }
}

extension FeedbackComposer {
    static func forApp(server: URL?) -> FeedbackComposer {
        FeedbackComposer(server: server, clientMetadata: .current, diagnosticStore: .shared)
    }
}

extension FeedbackClient {
    @MainActor static var current: Self {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return Self(appVersion: "\(version) (\(build))", osVersion: UIDevice.current.systemVersion,
                    deviceModel: String(decoding: machine.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self))
    }
}

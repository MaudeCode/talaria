import PhotosUI
import SwiftUI
import TalariaKit
import UIKit

/// Uses the same native form presentation as CreateProfileSheet; submission stays in the draft owner.
struct FeedbackSheet: View {
    static var title: String { String(localized: "Send Feedback") }
    static let systemImage = "bubble.and.pencil"
    @Bindable var model: FeedbackComposer
    @State private var diagnosticsExpanded = false
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
                    TextField("Title", text: field(\.title))
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
                            if let error = model.diagnosticsError {
                                SettingsErrorFootnote(error)
                                Button("Retry") { Task { await model.loadDiagnostics() } }
                            }
                        }
                    }
                }
                if let error = model.validationError ?? model.error {
                    Section { SettingsErrorFootnote(error) }
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
                PhotosPicker(selection: $pickedItems, maxSelectionCount: model.remainingAttachmentSlots,
                             matching: model.videoAllowed ? .any(of: [.images, .videos]) : .images) {
                    Label(model.videoAllowed ? "Add Photo or Video" : "Add Photo", systemImage: "photo.on.rectangle")
                }
                .accessibilityIdentifier("feedback-add-attachment")
            }
            if let error = model.attachmentError {
                SettingsErrorFootnote(error)
            }
        }
        .disabled(model.hasUnknownOutcome)
    }

    /// Videos arrive as a temporary file copy, removed once compressed; photos arrive as data.
    private func attach(_ items: [PhotosPickerItem]) async {
        for item in items {
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                guard let movie = try? await item.loadTransferable(type: PickedMovie.self) else { continue }
                await model.addVideo(at: movie.url)?.value
                try? FileManager.default.removeItem(at: movie.url)
            } else if let data = try? await item.loadTransferable(type: Data.self) {
                model.addImage(data)
            }
        }
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
    func feedbackPresentation(_ model: FeedbackComposer?, isEnabled: Bool = true, onDismiss: (() -> Void)? = nil) -> some View {
        sheet(isPresented: Binding(get: { isEnabled && model?.isPresented == true }, set: { value in
            if isEnabled { model?.isPresented = value }
        }), onDismiss: onDismiss) {
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

extension FeedbackClient {
    static var current: Self {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return Self(appVersion: "\(version) (\(build))", osVersion: UIDevice.current.systemVersion,
                    deviceModel: String(cString: machine))
    }
}

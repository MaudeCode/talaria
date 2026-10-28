import SwiftUI
import TalariaKit
import UIKit

/// Uses the same native form presentation as CreateProfileSheet; submission stays in the draft owner.
struct FeedbackSheet: View {
    @Bindable var model: FeedbackComposer
    @State private var diagnosticsExpanded = false

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
            .navigationTitle("Send Feedback")
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
        }
        .adaptiveFormPresentation()
    }

    private func field<Value>(_ path: WritableKeyPath<FeedbackRequest, Value>) -> Binding<Value> {
        Binding(get: { model.draft[keyPath: path] }, set: { value in model.edit { $0[keyPath: path] = value } })
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

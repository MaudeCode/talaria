import SwiftUI
import TalariaKit

/// Reuses the Settings page and picker kit; the tail alone owns an inner scroll container.
struct LogsSettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.locale) private var locale
    @Environment(\.timeZone) private var timeZone
    @State private var showsError = false
    @State private var model: LogsSettingsModel

    init(server: URL) {
        _model = State(initialValue: LogsSettingsModel(client: APIClient(baseURL: server)))
    }

    var body: some View {
        GeometryReader { geometry in
            SettingsCategoryPage(category: .logs) {
                controls
                logContent(height: max(160, geometry.size.height - 250))
            }
            .refreshable { await model.load() }
        }
        .toolbar {
            if model.response != nil, let error = model.errorMessage {
                ToolbarItem(placement: .primaryAction) {
                    Button { showsError = true } label: {
                        Label("Could Not Load Logs", systemImage: "exclamationmark.triangle")
                    }
                    .tint(.orange)
                    .popover(isPresented: $showsError) {
                        VStack {
                            SettingsErrorFootnote(SettingsErrorText(error))
                            Button("Try Again") { showsError = false; Task { await model.load() } }
                        }
                        .padding()
                        .presentationCompactAdaptation(.popover)
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                RefreshToolbarButton(isLoading: model.isLoading) { Task { await model.load() } }
            }
            ToolbarItem(placement: .primaryAction) {
                ShareLink(item: model.text) { Label(SettingsIndex.logsShare.title, systemImage: "square.and.arrow.up") }
                    .disabled(model.text.isEmpty)
                    .accessibilityIdentifier("settings-logs-share")
            }
        }
        .task(id: RefreshID(file: model.file, tail: model.tail, isActive: scenePhase == .active)) {
            await model.follow(isActive: scenePhase == .active, clock: ContinuousClock())
        }
    }

    private var controls: some View {
        SettingsSection {
            SettingsPickerRow(title: SettingsIndex.logsFile.title, systemImage: "doc.text", selection: $model.file,
                              accessibilityIdentifier: "settings-logs-file") {
                if model.files.isEmpty { Text(fileTitle(model.file)).tag(model.file) }
                ForEach(model.files) { file in Text(fileTitle(file.id)).tag(file.id) }
            }
            SettingsPickerRow(title: SettingsIndex.logsLines.title, systemImage: "text.alignleft", selection: $model.tail,
                              accessibilityIdentifier: "settings-logs-lines") {
                ForEach([200, 500, 1000, 2000], id: \.self) { Text($0, format: .number).tag($0) }
            }
        } header: {
            SidebarSectionHeader(title: String(localized: "Logs")) {
                VStack(alignment: .trailing) {
                    if let bytes = model.response?.totalBytes {
                        Text(Int64(bytes), format: .byteCount(style: .file))
                    }
                    if let mtime = model.response?.mtime {
                        Text(Date(timeIntervalSince1970: mtime), format: Date.FormatStyle(
                            date: .omitted, time: .shortened, locale: locale, timeZone: timeZone
                        ))
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                if model.isLoading { ProgressView().controlSize(.small) }
            }
        }
    }

    @ViewBuilder
    private func logContent(height: CGFloat) -> some View {
        if model.response == nil, let error = model.errorMessage {
            ContentUnavailableView {
                Label("Could Not Load Logs", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
            .listRowSeparator(.hidden)
        }
        if let response = model.response {
            if response.lines.isEmpty {
                SettingsFootnote(response.hint ?? "")
                    .listRowSeparator(.hidden)
            } else {
                SelectableTextView(text: model.text, isLogTail: true)
                    .frame(height: height)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(SettingsIndex.logsLogText.title)
                    .accessibilityValue(model.text)
                    .indexedSettingsRow(title: SettingsIndex.logsLogText.title)
                .listRowSeparator(.hidden)
                if response.truncated == true {
                    SettingsFootnote(String(localized: "Showing the last \(model.tail) lines"))
                        .listRowSeparator(.hidden)
                }
            }
        }
    }

    private func fileTitle(_ id: String) -> String {
        switch id {
        case "agent": String(localized: "Agent")
        case "webui": String(localized: "Web")
        case "gateway": String(localized: "Gateway")
        case "bootstrap": String(localized: "Bootstrap")
        default: id
        }
    }

    private struct RefreshID: Equatable {
        let file: String
        let tail: Int
        let isActive: Bool
    }
}

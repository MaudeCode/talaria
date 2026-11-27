import SwiftUI
import TalariaKit

struct AgentBackupSettingsRow: View {
    let backup: AgentBackupSettings
    let server: URL
    let confirm: (AgentBackupStatus) -> Void
    @Environment(\.settingsScrollAnchor) private var scrollAnchor

    var body: some View {
        if let status = backup.status, status.available {
            SettingsItemRow(
                title: SettingsIndex.systemAgentBackup.title,
                subtitle: "\(status.server) · \(status.profile)",
                detail: detail(for: status.job),
                containsActions: true,
                isLoading: backup.write == .create || (status.job?.knownState == .running && backup.write == nil)
                    || backup.isDownloading
            ) {
                Image(systemName: "externaldrive").accessibilityHidden(true)
            } accessory: {
                if backup.isDownloading {
                    action("Cancel Download", icon: "xmark", id: "cancel-download", backup.stopDownloading)
                } else if backup.write == nil, backup.readback == nil {
                    controls(for: status)
                }
            }
        } else if scrollAnchor == .setting(.systemAgentBackup), backup.hasReadStatus {
            SettingsInfoRow(title: SettingsIndex.systemAgentBackup.title, value: String(localized: "Unavailable"))
        }
        if let error = backup.error {
            SettingsErrorFootnote(SettingsErrorText(error))
        }
    }

    @ViewBuilder
    private func controls(for status: AgentBackupStatus) -> some View {
        if let job = status.job {
            switch job.knownState {
            case .running:
                action("Cancel Backup", icon: "xmark", id: "cancel") {
                    Task { await backup.apply(.cancel(job.id), on: server) }
                }
            case .ready:
                if job.downloadUrl != nil {
                    action("Download Backup", icon: "arrow.down.to.line", id: "download") {
                        backup.download(job, from: server)
                    }
                }
            case .failed, .cancelled:
                createButton(status)
            case nil:
                EmptyView()
            }
        } else {
            createButton(status)
        }
    }

    private func createButton(_ status: AgentBackupStatus) -> some View {
        action("Create Backup", icon: "archivebox", id: "create") { confirm(status) }
    }

    private func action(_ title: LocalizedStringKey, icon: String, id: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: icon).frame(width: 44, height: 44)
        }
        .buttonStyle(.borderless)
        .help(title)
        .accessibilityLabel(title)
        .accessibilityIdentifier("agent-backup-\(id)")
    }

    private func detail(for job: AgentBackupJob?) -> String? {
        if backup.isDownloading { return String(localized: "Downloading backup…") }
        if backup.write == .create { return String(localized: "Starting backup…") }
        if case .cancel = backup.readback { return String(localized: "Checking backup status…") }
        if case .cancel = backup.write, backup.error == nil { return String(localized: "Backup cancelled") }
        guard let job else { return nil }
        switch job.knownState {
        case .running:
            switch job.phase {
            case "archiving":
                if let completed = job.completed, let total = job.total {
                    return String(localized: "\(completed) of \(total) files archived")
                }
                return String(localized: "Archiving files…")
            case "scanning": return String(localized: "Scanning files…")
            default: return String(localized: "Starting backup…")
            }
        case .ready:
            if job.complete == false { return String(localized: "Incomplete backup") }
            if let bytes = job.sizeBytes {
                return String(localized: "Ready to download · \(bytes.formatted(.byteCount(style: .file)))")
            }
            return String(localized: "Ready to download")
        case .failed: return String(localized: "Backup failed")
        case .cancelled: return String(localized: "Backup cancelled")
        case nil: return String(localized: "Backup status unavailable")
        }
    }
}

/// Owns the confirmed status and the local state of the System page's backup actions.
@MainActor @Observable
final class AgentBackupSettings {
    enum Write: Equatable {
        case create
        case cancel(String)
    }

    enum Poll: Equatable {
        case status
        case expiry(Double)
    }

    private(set) var status: AgentBackupStatus?
    private(set) var hasReadStatus = false
    private(set) var write: Write?
    private(set) var error: String?
    private(set) var readback: Write?
    var shareItem: SessionExportShareItem?
    @ObservationIgnored private var readRevision = 0
    private var downloadTask: Task<Void, Never>?

    var isDownloading: Bool { downloadTask != nil }

    var poll: Poll? {
        if readback != nil { return .status }
        guard status?.available == true, let job = status?.job else { return nil }
        if job.knownState == .running { return .status }
        if job.knownState == .ready, let expiry = job.expiresAt { return .expiry(expiry) }
        return nil
    }

    func pollStatus(on server: URL) async {
        guard poll != nil else { return }
        let client = APIClient(baseURL: server)
        while let poll {
            let delay = switch poll {
            case .status: 1.0
            case .expiry(let expiry): max(1, min(60, expiry - Date().timeIntervalSince1970))
            }
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
            await load(using: client)
        }
    }

    func load(on server: URL) async {
        await load(using: APIClient(baseURL: server))
    }

    private func load(using client: APIClient) async {
        guard write == nil, !Task.isCancelled else { return }
        readRevision += 1
        let revision = readRevision
        defer {
            if !Task.isCancelled, readRevision == revision { hasReadStatus = true }
        }
        do {
            let next = try await client.agentBackupStatus()
            guard !Task.isCancelled, readRevision == revision else { return }
            status = next
            if readback != nil { error = nil }
            readback = nil
        } catch {
            guard !Task.isCancelled, readRevision == revision else { return }
            hideIfInaccessible(error)
        }
    }

    func apply(_ action: Write, on server: URL, confirmed: AgentBackupStatus? = nil) async {
        guard let previous = status, previous.available, readback == nil, write == nil else { return }
        if case .create = action {
            guard previous.server == confirmed?.server, previous.profile == confirmed?.profile,
                  previous.job?.id == confirmed?.job?.id, previous.job?.knownState == confirmed?.job?.knownState else { return }
        }
        if case .cancel(let id) = action {
            guard previous.job?.id == id, previous.job?.knownState == .running else { return }
        }

        readRevision += 1
        write = action
        error = nil
        defer { write = nil }
        let client = APIClient(baseURL: server)
        do {
            switch action {
            case .create: status = try await client.createAgentBackup()
            case .cancel(let id): status = try await client.discardAgentBackup(id: id)
            }
        } catch {
            await reconcile(action, previous: previous, failure: error, using: client)
        }
    }

    private func reconcile(_ action: Write, previous: AgentBackupStatus, failure: Error, using client: APIClient) async {
        let refused = APIError.isDefinitiveWriteFailure(failure)
        if refused {
            hideIfInaccessible(failure)
            error = String(localized: "The server refused the backup request.")
        }
        do {
            let next = try await client.agentBackupStatus()
            status = next
            guard !refused else { return }
            let reflected = switch action {
            case .create: next.job != nil && next.job?.id != previous.job?.id
            case .cancel(let id): next.job?.id != id || next.job?.knownState != .running
            }
            if !reflected { error = String(localized: "Could not confirm the backup action.") }
        } catch {
            let inaccessible = hideIfInaccessible(error)
            guard !refused else { return }
            if !inaccessible { readback = action }
            self.error = String(localized: "Could not confirm the backup action.")
        }
    }

    @discardableResult
    private func hideIfInaccessible(_ error: Error) -> Bool {
        switch error as? APIError {
        case .unauthorized, .http(403, _), .http(404, _):
            status = nil
            readback = nil
            return true
        default: return false
        }
    }

    func download(_ job: AgentBackupJob, from server: URL) {
        guard downloadTask == nil, shareItem == nil else { return }
        error = nil
        let client = APIClient(baseURL: server)
        downloadTask = Task {
            defer { downloadTask = nil }
            do {
                let file = try await client.downloadAgentBackup(job)
                if Task.isCancelled {
                    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
                } else {
                    shareItem = SessionExportShareItem(fileURL: file)
                }
            } catch {
                guard !Task.isCancelled, !APIError.isCancellation(error) else { return }
                self.error = String(localized: "Could not download the backup.")
                await load(using: client)
            }
        }
    }

    func stopDownloading() { downloadTask?.cancel() }
}

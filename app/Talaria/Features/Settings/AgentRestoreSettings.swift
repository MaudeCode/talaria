import SwiftUI
import TalariaKit

struct AgentRestoreSettingsRow: View {
    let restore: AgentRestoreSettings
    let archiveDownload: AgentArchiveDownload
    let server: URL
    let chooseArchive: () -> Void
    let confirm: (AgentRestoreStatus) -> Void
    @Environment(\.settingsScrollAnchor) private var scrollAnchor

    var body: some View {
        if let status = restore.status, status.available || status.job != nil {
            SettingsItemRow(
                title: SettingsIndex.systemAgentRestore.title,
                subtitle: "\(status.server) · \(status.profile)",
                detail: detail(for: status.job),
                detailLineLimit: nil,
                containsActions: true,
                isLoading: restore.write != nil || status.job?.knownState == .running || isDownloading
            ) {
                Image(systemName: "arrow.counterclockwise").accessibilityHidden(true)
            } accessory: {
                if isDownloading {
                    agentArchiveAction("Cancel Download", icon: "xmark", id: "agent-restore-cancel-download", archiveDownload.stop)
                } else if restore.write == nil, restore.readback == nil {
                    actions(for: status)
                }
            }
        } else if scrollAnchor == .setting(.systemAgentRestore), restore.hasReadStatus {
            SettingsInfoRow(title: SettingsIndex.systemAgentRestore.title, value: String(localized: "Unavailable"))
        }
        if let error = restore.error {
            SettingsErrorFootnote(SettingsErrorText(error))
        }
    }

    private var isDownloading: Bool { archiveDownload.source == .systemAgentRestore }

    @ViewBuilder
    private func actions(for status: AgentRestoreStatus) -> some View {
        if status.canUpload {
            agentArchiveAction("Choose Restore Archive", icon: "arrow.up.to.line", id: "agent-restore-upload", chooseArchive)
        }
        if let job = status.job {
            if job.canConfirm {
                agentArchiveAction("Review Restore", icon: "arrow.counterclockwise", id: "agent-restore-confirm") { confirm(status) }
            }
            if job.recoveryUrl != nil {
                agentArchiveAction("Download Recovery Backup", icon: "arrow.down.to.line", id: "agent-restore-recovery") {
                    restore.download(job, from: server, using: archiveDownload)
                }
            }
        }
    }

    private func detail(for job: AgentRestoreJob?) -> String? {
        if isDownloading { return String(localized: "Downloading recovery backup…") }
        if let write = restore.write {
            return switch write {
            case .stage: String(localized: "Uploading restore archive…")
            case .confirm: String(localized: "Starting restore…")
            }
        }
        guard let job else { return nil }
        return switch job.knownState {
        case .staged: String(localized: "\(job.fileName) is ready for confirmation.")
        case .running: String(localized: "Restoring Agent home…")
        case .restored: String(localized: "Agent home restored.")
        case .invalidArchive: String(localized: "The server rejected the archive. Nothing was restored.")
        case .refused: String(localized: "The destination failed a safety check. Nothing was restored.")
        case .busy: String(localized: "The Agent is busy. Nothing was restored.")
        case .backupFailed: String(localized: "The recovery backup failed. Nothing was restored.")
        case .partial: String(localized: "Partial restore. Some data may have changed.")
        case .unknown: String(localized: "The restore outcome is unknown.")
        case .unavailable: String(localized: "Agent-home restore is unavailable.")
        case nil: String(localized: "Restore status unavailable.")
        }
    }
}

/// Keeps the server's current receipt and the local state of its upload/confirm controls.
@MainActor @Observable
final class AgentRestoreSettings {
    enum Write {
        case stage
        case confirm(String)
    }

    private(set) var status: AgentRestoreStatus?
    private(set) var hasReadStatus = false
    private(set) var write: Write?
    private(set) var readback: Write?
    private(set) var error: String?
    @ObservationIgnored private var readRevision = 0

    var shouldPoll: Bool {
        readback != nil || status?.job?.knownState == .running
            || (status?.job?.knownState == .unknown && status?.canUpload == false)
    }

    func load(on server: URL) async {
        guard write == nil else { return }
        await refresh(using: APIClient(baseURL: server))
    }

    func pollStatus(on server: URL) async {
        guard shouldPoll else { return }
        let client = APIClient(baseURL: server)
        while shouldPoll {
            do { try await Task.sleep(for: .seconds(1)) }
            catch { return }
            if write == nil { await refresh(using: client) }
        }
    }

    func stage(_ archive: URL, on server: URL) async {
        guard status?.canUpload == true else { return }
        await apply(.stage, on: server) { try await $0.stageAgentRestore(archive: archive) }
    }

    func confirm(_ presented: AgentRestoreStatus, on server: URL) async {
        guard let current = status, let job = current.job, job.canConfirm,
              job.id == presented.job?.id, job.fileName == presented.job?.fileName,
              current.server == presented.server, current.profile == presented.profile else { return }
        await apply(.confirm(job.id), on: server) { try await $0.confirmAgentRestore(id: job.id) }
    }

    func failedToOpenArchive(_ failure: Error) {
        guard (failure as? CocoaError)?.code != .userCancelled else { return }
        error = String(localized: "Could not open the restore archive.")
    }

    func download(_ job: AgentRestoreJob, from server: URL, using archive: AgentArchiveDownload) {
        let client = APIClient(baseURL: server)
        if archive.start(.systemAgentRestore, load: { try await client.downloadAgentRestoreRecovery(job) }, onFailure: {
            self.error = String(localized: "Could not download the recovery backup.")
            if self.write == nil { await self.refresh(using: client) }
        }) { error = nil }
    }

    private func apply(_ action: Write, on server: URL, send: (APIClient) async throws -> AgentRestoreStatus) async {
        guard write == nil, readback == nil else { return }
        readRevision += 1
        write = action
        error = nil
        defer { write = nil }
        let client = APIClient(baseURL: server)
        do {
            status = try await send(client)
        } catch {
            if APIError.isDefinitiveWriteFailure(error) {
                self.error = String(localized: "The server refused the restore request.")
            } else {
                readback = action
                self.error = switch action {
                case .stage: String(localized: "Could not verify the upload. Check the archive name before confirming.")
                case .confirm: String(localized: "Could not verify the restore. Check its status before trying again.")
                }
            }
            await refresh(using: client)
        }
    }

    private func refresh(using client: APIClient) async {
        guard !Task.isCancelled else { return }
        readRevision += 1
        let revision = readRevision
        defer {
            if !Task.isCancelled, revision == readRevision { hasReadStatus = true }
        }
        do {
            let next = try await client.agentRestoreStatus()
            guard !Task.isCancelled, revision == readRevision else { return }
            status = next
            if case let .confirm(id) = readback, let job = next.job, job.id == id,
               let state = job.knownState, state != .staged { error = nil }
            readback = nil
        } catch {
            guard !Task.isCancelled, revision == readRevision else { return }
            switch error as? APIError {
            case .unauthorized, .http(403, _), .http(404, _):
                status = nil
                readback = nil
            default: break
            }
        }
    }
}

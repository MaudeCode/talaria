import Foundation
public import Observation

/// Reserves queued share-extension imports one at a time and tracks whether more are waiting.
@MainActor
@Observable
public final class SharedImportRouter {
    /// The reserved import the session list routes into a new chat.
    public var pendingImport: SharedImportReservation?
    /// More shares remain in the inbox after the routed one.
    public private(set) var hasWaitingImport = false
    @ObservationIgnored private var hasRoutedImport = false
    @ObservationIgnored private var inFlightImport: Task<Void, Never>?
    @ObservationIgnored private let directory: () -> URL?

    public init(directory: @escaping () -> URL? = { TalariaShareDraft.containerURL() }) {
        self.directory = directory
    }

    /// Launch, foreground, and the share URL can all fire at once; each trigger waits for the
    /// in-flight pass, then runs its own so only one reservation is ever taken at a time (TAL-554).
    public func importIfAvailable() async {
        while let inFlightImport {
            await inFlightImport.value
        }
        let pass = Task {
            await reserveNextImport()
            inFlightImport = nil
        }
        inFlightImport = pass
        await pass.value
    }

    private func reserveNextImport() async {
        guard pendingImport == nil else {
            return
        }

        guard let directory = directory() else {
            return
        }

        guard !hasRoutedImport else {
            await refreshWaitingImport(in: directory)
            return
        }

        do {
            if let reservation = try await TalariaShareDraft.reserveNextPendingImportOffMainActor(from: directory) {
                pendingImport = reservation
            }
            await refreshWaitingImport(in: directory)
        } catch {
            hasWaitingImport = false
        }
    }

    @discardableResult
    public func didRoute(_ reservation: SharedImportReservation) -> Task<Void, Never> {
        hasRoutedImport = true

        return Task {
            guard let directory = directory() else {
                return
            }

            do {
                try await TalariaShareDraft.consumeOffMainActor(reservation, from: directory)
            } catch {
                try? await TalariaShareDraft.releaseOffMainActor(reservation, in: directory)
            }
            if pendingImport?.reservationID == reservation.reservationID {
                pendingImport = nil
            }
            await refreshWaitingImport(in: directory)
        }
    }

    @discardableResult
    public func openNext() -> Task<Void, Never> {
        hasWaitingImport = false
        hasRoutedImport = false
        return Task { await importIfAvailable() }
    }

    private func refreshWaitingImport(in directory: URL) async {
        hasWaitingImport = (try? await TalariaShareDraft.hasPendingImportOffMainActor(in: directory)) ?? false
    }
}

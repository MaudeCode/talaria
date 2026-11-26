import CoreGraphics
import Foundation
import Observation

/// One chat's viewer. Only the server can grant input, and a new socket always starts in watch mode.
@MainActor
@Observable
public final class ScreenSession {
    public enum End: Equatable, Sendable {
        case disconnected, controlTaken, desktopGone, signedOut
    }

    public private(set) var screen: AgentScreen?
    public private(set) var frame: CGImage?
    public private(set) var end: End?
    public private(set) var error: APIError?
    public private(set) var isLoading = true
    public var control: AgentScreen.Control? { requestedControl ?? screen?.control }
    public var canChangeControl: Bool { frame != nil && leaseTask == nil && closeTask == nil }
    public var canSendInput: Bool { frame != nil && control == .you && screen?.control == .you && closeTask == nil }

    private let client: any ScreenServing
    private let sessionID: String
    private var requestedControl: AgentScreen.Control?
    private var viewID: String?
    private var streamTask: Task<Void, Error>?
    private var leaseTask: Task<Void, Never>?
    private var closeTask: Task<Void, Never>?
    @ObservationIgnored private var connection: RFBClient?
    @ObservationIgnored private var inputTask: Task<Void, Never>?
    @ObservationIgnored private var pendingInput: [(buttonMask: UInt8?, data: Data)] = []

    public convenience init(client: APIClient, sessionID: String) {
        self.init(service: client, sessionID: sessionID)
    }

    init(service: any ScreenServing, sessionID: String) {
        client = service
        self.sessionID = sessionID
    }

    /// A fresh detail authorizes this opening and supplies the current installation state.
    public func watch() async {
        guard closeTask == nil, viewID == nil else { return }
        isLoading = true
        end = nil
        error = nil
        let id = UUID().uuidString
        viewID = id
        defer {
            viewID = nil
            connection = nil
            streamTask = nil
            frame = nil
            requestedControl = nil
            discardInput()
            isLoading = false
        }
        do {
            let screen = try await client.screen(sessionID: sessionID)
            try Task.checkCancellation()
            guard closeTask == nil else { return }
            self.screen = screen
            guard screen?.available == true, screen?.state == .running else { return }
            let socket = try await client.openScreen(viewID: id)
            guard !Task.isCancelled, closeTask == nil else { socket.close(); return }
            let connection = RFBClient(socket: socket) { [weak self] image in
                await self?.receive(image, viewID: id)
            }
            self.connection = connection
            // Keep the socket open through an in-flight lease write and the final release.
            let streamTask = Task { try await connection.run() }
            self.streamTask = streamTask
            try await withTaskCancellationHandler {
                try await streamTask.value
            } onCancel: {
                Task { await self.close() }
            }
        } catch where Task.isCancelled || closeTask != nil {
            return
        } catch RFBStreamEnd.closed(let code) {
            switch code {
            case 4000: end = .controlTaken
            case 4001: end = .desktopGone
            case 4401: end = .signedOut
            default: end = .disconnected
            }
        } catch APIError.unauthorized {
            end = .signedOut
        } catch {
            end = .disconnected
        }
    }

    private func receive(_ image: CGImage, viewID: String) {
        guard self.viewID == viewID, closeTask == nil else { return }
        frame = image
        isLoading = false
    }

    public func changeControl() async {
        guard canChangeControl, let id = viewID else { return }
        let action: ScreenLeaseAction = control == .you ? .release : .acquire
        requestedControl = action == .acquire ? .you : .agent
        if action == .release { discardInput() }
        error = nil
        let write = Task {
            defer { leaseTask = nil }
            do {
                let confirmed = try await client.screenLease(viewID: id, action: action)
                guard viewID == id, closeTask == nil else { return }
                screen = confirmed
                requestedControl = nil
            } catch {
                await reconcileLease(viewID: id, failure: error)
            }
        }
        leaseTask = write
        await write.value
    }

    private func reconcileLease(viewID id: String, failure: Error) async {
        guard viewID == id, closeTask == nil else { return }
        let message = failure as? APIError ?? .network(underlying: failure)
        if APIError.isDefinitiveWriteFailure(failure) {
            error = message
            requestedControl = nil
            return
        }
        do {
            let confirmed = try await client.screenView(viewID: id)
            guard viewID == id, closeTask == nil else { return }
            if confirmed.control != requestedControl { error = message }
            screen = confirmed
            requestedControl = nil
        } catch {
            // Socket closure also releases on Web. Never enable input with an unknown lease.
            guard viewID == id, closeTask == nil else { return }
            streamTask?.cancel()
        }
    }

    /// Joins a lease write already sent, then hands back before discarding the socket.
    public func close() async {
        if let closeTask { await closeTask.value; return }
        let id = viewID
        let activeLease = leaseTask
        let stream = streamTask
        let canHaveControl = control == .you || screen?.control == .you || activeLease != nil
        let task = Task {
            await activeLease?.value
            if let id, canHaveControl, stream != nil {
                // If this request is lost, closing the socket still releases its lease on Web.
                _ = try? await client.screenLease(viewID: id, action: .release)
            }
            stream?.cancel()
            _ = await stream?.result
        }
        closeTask = task
        discardInput()
        await task.value
    }

    public func pointer(x: Int, y: Int, buttonMask: UInt8) {
        guard canSendInput, let frame else { return }
        let x = min(max(x, 0), frame.width - 1), y = min(max(y, 0), frame.height - 1)
        queue(Data([5, buttonMask, UInt8(x >> 8), UInt8(x & 255), UInt8(y >> 8), UInt8(y & 255)]), buttonMask: buttonMask)
    }

    public func key(_ symbol: UInt32, down: Bool) {
        let bytes = Data([4, down ? 1 : 0, 0, 0, UInt8(symbol >> 24), UInt8((symbol >> 16) & 255),
                          UInt8((symbol >> 8) & 255), UInt8(symbol & 255)])
        queue(bytes)
    }

    /// Replaces queued pointer moves with the last position, preserving clicks and keystroke order.
    private func queue(_ data: Data, buttonMask: UInt8? = nil) {
        guard canSendInput, let connection else { return }
        if let buttonMask, pendingInput.last?.buttonMask == buttonMask { pendingInput.removeLast() }
        pendingInput.append((buttonMask, data))
        guard inputTask == nil else { return }
        inputTask = Task {
            defer { inputTask = nil }
            while canSendInput, !pendingInput.isEmpty, !Task.isCancelled {
                let batch = pendingInput.reduce(into: Data()) { $0.append($1.data) }
                pendingInput.removeAll(keepingCapacity: true)
                do {
                    try await connection.send(batch)
                } catch {
                    if !Task.isCancelled { streamTask?.cancel() }
                    return
                }
            }
        }
    }

    private func discardInput() {
        pendingInput.removeAll()
        inputTask?.cancel()
    }
}

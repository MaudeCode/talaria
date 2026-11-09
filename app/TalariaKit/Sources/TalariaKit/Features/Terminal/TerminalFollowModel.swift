import Foundation
import Observation

/// TAL-1997: the read-only view of the terminal a `terminal_open` card names. It reads the server's text from the start,
/// then again from its cursor on each event of the session's terminal output stream, until the shell exits. The server
/// strips escape sequences and applies carriage returns; the view only appends lines, or replaces the last one when the
/// server restates it.
@MainActor
@Observable
public final class TerminalFollowModel {
    public let sessionID: String
    public let reference: TerminalRef
    public private(set) var lines: [String] = []
    public private(set) var running = true
    /// The shell's exit code once it exited.
    public private(set) var exitCode: Int?
    /// The server no longer has this terminal: another replaced it, or it was retired after it closed.
    public private(set) var gone = false
    /// The last read failed for another reason; the next event or reconnect reads again.
    public private(set) var lastError: Error?
    @ObservationIgnored private var cursor = 0
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var readAgain = false
    @ObservationIgnored private var following = false
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let stream: SSEStreamingClient
    @ObservationIgnored private let reconnectDelay: Duration

    public init(sessionID: String, reference: TerminalRef, client: APIClient, stream: SSEStreamingClient = SSEClient(), reconnectDelay: Duration = .seconds(2)) {
        self.sessionID = sessionID
        self.reference = reference
        self.client = client
        self.stream = stream
        self.reconnectDelay = reconnectDelay
    }

    /// Reads once, then follows the output stream while the shell runs.
    public func start() async {
        following = true
        await read()
        if running, !gone { connect() }
    }

    public func stop() {
        following = false
        stream.stop()
    }

    private func connect() {
        stream.start(url: client.terminalOutputStreamURL(sessionID: sessionID)) { [weak self] event in
            guard let self else { return }
            switch event {
            case .heartbeat:
                return
            case .transportError:
                // The stream ended: the shell exited, the network dropped, or the session has no terminal now.
                Task { await self.reconnect() }
            default:
                Task { await self.read() }
            }
        }
    }

    private func reconnect() async {
        await read()
        guard following, running, !gone else { return }
        try? await Task.sleep(for: reconnectDelay)
        if following, running, !gone { connect() }
    }

    /// One read at a time; events that arrive meanwhile read once more after it, and a capped read continues at once.
    public func read() async {
        guard !reading else { readAgain = true; return }
        reading = true
        defer { reading = false }
        repeat {
            readAgain = false
            do {
                let slice = try await client.terminalRead(sessionID: sessionID, terminalID: reference.terminalId, afterEventID: cursor)
                if slice.truncated, slice.nextEventId > cursor { readAgain = true }
                apply(slice)
                lastError = nil
            } catch {
                if APIError.isCancellation(error) { return }
                if (error as? APIError)?.serverMessage == "terminal_not_found" {
                    gone = true
                    stream.stop()
                } else {
                    lastError = error
                }
                return
            }
        } while readAgain
        if !running { stream.stop() }
    }

    private func apply(_ slice: TerminalSlice) {
        if slice.replacesLastLine, !lines.isEmpty { lines.removeLast() }
        if slice.lines > 0 { lines.append(contentsOf: slice.output.components(separatedBy: "\n")) }
        cursor = slice.nextEventId
        running = slice.running
        exitCode = slice.exitCode
    }
}

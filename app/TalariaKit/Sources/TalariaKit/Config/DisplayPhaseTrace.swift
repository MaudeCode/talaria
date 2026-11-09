import Foundation
import OSLog

/// The phases a user waits on, as `os_signpost` intervals for Instruments and `scripts/benchmark-display-phases`
/// (TAL-1412). Filter by the app's bundle identifier and category `Performance`.
///
/// A traced operation opens `<Phase>`, which ends at its first visible frame (cached rows, an empty state or the New
/// Chat composer), and `<Phase> Ready`, which ends at its first canonical frame, after the server's transcript applies.
/// `Load Earlier` has no cached phase and opens only its `Ready`-style interval. Every interval ends exactly once, and
/// its only metadata is an outcome and a row count: session IDs, titles, paths, text and credentials never reach it.
public enum DisplayPhase: Sendable {
    /// From `TalariaApp.init` to the first root: the restored chat's transcript or the New Chat composer.
    case launch
    /// From a session-list open (`SessionListView.openSession`, which taps, deep links and shares share) to the chat.
    case sessionOpen
    /// From an older-history request to the layout of the prepended rows; its row count is the rows shown before.
    case loadEarlier

    var visibleName: StaticString? {
        switch self {
        case .launch: "Launch"
        case .sessionOpen: "Session Open"
        case .loadEarlier: nil
        }
    }

    var readyName: StaticString {
        switch self {
        case .launch: "Launch Ready"
        case .sessionOpen: "Session Open Ready"
        case .loadEarlier: "Load Earlier"
        }
    }
}

public enum DisplayPhaseOutcome: String, Sendable {
    /// Rows painted from the device cache before the server answered.
    case cache
    /// The server's transcript, rows or its empty state.
    case server
    /// The New Chat composer, which waits on no server.
    case composer
    /// A chat the scene kept loaded across a navigation rebuild.
    case retained
    /// The load failed and the error state shows.
    case failed
    /// Not reached: the launch showed onboarding instead of a root.
    case onboarding
    /// Not reached: a newer open replaced this one before its chat showed.
    case replaced
    /// Not reached: the operation was abandoned, such as a failed open or a torn-down view.
    case cancelled
}

/// Begins and ends named intervals; `OSDisplayPhaseSignposter` is the real one, tests record.
@MainActor
public protocol DisplayPhaseSignposting: AnyObject {
    func begin(_ name: StaticString) -> Int
    func end(_ name: StaticString, _ handle: Int, metadata: String)
}

@MainActor
public final class OSDisplayPhaseSignposter: DisplayPhaseSignposting {
    public static let shared = OSDisplayPhaseSignposter()

    /// Compiled into every build: Instruments profiles Release builds, and an idle signposter costs almost nothing.
    private let signposter = OSSignposter(subsystem: Bundle.main.bundleIdentifier ?? "Talaria", category: "Performance")
    private var states: [Int: OSSignpostIntervalState] = [:]
    private var nextHandle = 0

    public func begin(_ name: StaticString) -> Int {
        nextHandle += 1
        states[nextHandle] = signposter.beginInterval(name, id: signposter.makeSignpostID())
        return nextHandle
    }

    public func end(_ name: StaticString, _ handle: Int, metadata: String) {
        guard let state = states.removeValue(forKey: handle) else { return }
        signposter.endInterval(name, state, "\(metadata, privacy: .public)")
    }
}

/// One traced operation. Its owner holds it, so a replaced or concurrent operation can never end another's intervals.
@MainActor
public final class DisplayPhaseOperation {
    private let signposter: any DisplayPhaseSignposting
    private var visible: (name: StaticString, handle: Int)?
    private var ready: (name: StaticString, handle: Int)?

    public init(_ phase: DisplayPhase, signposter: any DisplayPhaseSignposting = OSDisplayPhaseSignposter.shared) {
        self.signposter = signposter
        visible = phase.visibleName.map { ($0, signposter.begin($0)) }
        ready = (phase.readyName, signposter.begin(phase.readyName))
    }

    public var isOpen: Bool { visible != nil || ready != nil }

    /// The first visible frame. Later calls, and calls after `cancel`, are ignored.
    public func markVisible(_ outcome: DisplayPhaseOutcome, rows: Int) {
        guard let visible else { return }
        self.visible = nil
        endAfterLayout(visible, outcome, rows)
    }

    /// The first canonical frame; it is also the first visible one when nothing showed before it.
    public func markReady(_ outcome: DisplayPhaseOutcome, rows: Int) {
        markVisible(outcome, rows: rows)
        guard let ready else { return }
        self.ready = nil
        endAfterLayout(ready, outcome, rows)
    }

    /// Ends every interval still open as not reached.
    public func cancel(_ outcome: DisplayPhaseOutcome) {
        for interval in [visible, ready].compactMap({ $0 }) {
            signposter.end(interval.name, interval.handle, metadata: Self.metadata(outcome, rows: 0))
        }
        visible = nil
        ready = nil
    }

    /// Callers mark the state change that shows a frame; the interval ends a main-queue turn later, after that frame
    /// has laid out.
    private func endAfterLayout(_ interval: (name: StaticString, handle: Int), _ outcome: DisplayPhaseOutcome, _ rows: Int) {
        let signposter = signposter
        let metadata = Self.metadata(outcome, rows: rows)
        DispatchQueue.main.async {
            MainActor.assumeIsolated { signposter.end(interval.name, interval.handle, metadata: metadata) }
        }
    }

    /// Built only from the outcome and a count, so no session content can reach a trace.
    private static func metadata(_ outcome: DisplayPhaseOutcome, rows: Int) -> String {
        "outcome=\(outcome.rawValue) rows=\(rows)"
    }
}

/// A scene's one pending session open (each `SessionListView` owns one, so windows never share it). A new open
/// replaces the pending one, and only the chat of the session it resolved to can end it.
@MainActor
public final class SessionOpenTrace {
    private let signposter: any DisplayPhaseSignposting
    private var pending: (operation: DisplayPhaseOperation, sessionID: String?)?

    public init(signposter: any DisplayPhaseSignposting = OSDisplayPhaseSignposter.shared) {
        self.signposter = signposter
    }

    public func begin() -> DisplayPhaseOperation {
        pending?.operation.cancel(.replaced)
        let operation = DisplayPhaseOperation(.sessionOpen, signposter: signposter)
        pending = (operation, nil)
        return operation
    }

    /// The open selected `sessionID`; that chat's frames end it.
    public func resolve(_ operation: DisplayPhaseOperation, to sessionID: String?) {
        guard pending?.operation === operation, let sessionID else {
            cancel(operation)
            return
        }
        pending?.sessionID = sessionID
    }

    public func cancel(_ operation: DisplayPhaseOperation, _ outcome: DisplayPhaseOutcome = .cancelled) {
        operation.cancel(outcome)
        if pending?.operation === operation { pending = nil }
    }

    public func markVisible(sessionID: String?, _ outcome: DisplayPhaseOutcome, rows: Int) {
        operation(for: sessionID)?.markVisible(outcome, rows: rows)
    }

    public func markReady(sessionID: String?, _ outcome: DisplayPhaseOutcome, rows: Int) {
        guard let operation = operation(for: sessionID) else { return }
        operation.markReady(outcome, rows: rows)
        pending = nil
    }

    /// The chat closed before its open finished. A launch is not ended here: a root replaced before it showed, such
    /// as New Chat under a deep link, hands the launch to the next root.
    public func leave(sessionID: String?) {
        if let operation = operation(for: sessionID) { cancel(operation) }
    }

    private func operation(for sessionID: String?) -> DisplayPhaseOperation? {
        guard let pending, let sessionID, pending.sessionID == sessionID else { return nil }
        return pending.operation
    }
}

/// The process's launch, and the chat frames that end it and the scene's pending open.
@MainActor
public enum DisplayPhaseTrace {
    public private(set) static var launch: DisplayPhaseOperation?

    /// Called once from `TalariaApp.init`; a launch is never traced twice.
    public static func beginLaunch() {
        guard launch == nil else { return }
        launch = DisplayPhaseOperation(.launch)
    }

    /// A launch whose first screen is not a root, such as onboarding, ends as not reached rather than as ready.
    public static func launchNotReached(_ outcome: DisplayPhaseOutcome) {
        launch?.cancel(outcome)
    }

    public static func chatVisible(sessionID: String?, in scene: SessionOpenTrace?, _ outcome: DisplayPhaseOutcome, rows: Int) {
        launch?.markVisible(outcome, rows: rows)
        scene?.markVisible(sessionID: sessionID, outcome, rows: rows)
    }

    public static func chatReady(sessionID: String?, in scene: SessionOpenTrace?, _ outcome: DisplayPhaseOutcome, rows: Int) {
        launch?.markReady(outcome, rows: rows)
        scene?.markReady(sessionID: sessionID, outcome, rows: rows)
    }
}

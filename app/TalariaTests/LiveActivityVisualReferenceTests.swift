import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Visual references only. Behavioural assertions about Live Activity state
/// live in `LiveActivityTests`; nothing here asserts on anything but pixels.
@MainActor
final class LiveActivityVisualReferenceTests: XCTestCase {
    func testLockScreenReferences() throws {
        for scenario in AgentRunScenario.allCases {
            try VisualReference.assertMatchesReference(
                AgentRunLockScreenView(state: scenario.state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-lock-screen-\(scenario.rawValue)",
                size: CGSize(width: 360, height: 140),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
        }
    }

    /// TAL-874: a relay-driven run carries no excerpt; the panel shows its tool count and last activity instead, and an
    /// older Relay or Web, which sends neither, keeps the earlier wording.
    func testRelayLockScreenReferences() throws {
        let startedAt = AgentRunScenario.startedAt
        let relay = { (name: String, status: AgentRunActivityStatus, activity: String, toolCount: Int?, activityAt: Date?) in
            (name, AgentRunActivityAttributes.ContentState(
                sessionID: "session-visual-reference", sessionTitle: "Talaria visual references", status: status,
                currentActivity: activity, startedAt: startedAt, updatedAt: AgentRunScenario.frozenClock,
                isFinal: status == .complete, toolCount: toolCount, activityAt: activityAt
            ))
        }
        for (name, state) in [
            relay("tools", .thinking, "Working", 3, startedAt.addingTimeInterval(60)),
            relay("started", .thinking, "Working", 3, startedAt.addingTimeInterval(5)),
            relay("now", .thinking, "Working", 3, AgentRunScenario.frozenClock.addingTimeInterval(-5)),
            relay("finished", .complete, "Done", 3, AgentRunScenario.frozenClock),
            relay("legacy", .thinking, "Working", nil, nil),
        ] {
            try VisualReference.assertMatchesReference(
                AgentRunLockScreenView(state: state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-lock-screen-relay-\(name)",
                size: CGSize(width: 360, height: 140),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
        }
    }

    /// TAL-1422: the server's plan progress and running workers beside the activity line, in the expanded island and on
    /// the aggregate rows; one worker, many, and the largest counts the server sends.
    func testWorkCountsReferences() throws {
        let counted = { (plan: (Int, Int)?, workers: Int?) in
            AgentRunActivityAttributes.ContentState(
                sessionID: "session-visual-reference", sessionTitle: "Talaria visual references", status: .thinking,
                currentActivity: "Working", startedAt: AgentRunScenario.startedAt, updatedAt: AgentRunScenario.frozenClock,
                toolCount: 4, activityAt: AgentRunScenario.startedAt.addingTimeInterval(60),
                planCompleted: plan?.0, planTotal: plan?.1, workerCount: workers
            )
        }
        for (name, state) in [
            ("plan-workers", counted((2, 5), 3)),
            ("one-worker", counted((0, 0), 1)),
            ("large", counted((9_999, 9_999), 9_999)),
        ] {
            try VisualReference.assertMatchesReference(
                AgentRunLockScreenView(state: state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-lock-screen-counts-\(name)",
                size: CGSize(width: 360, height: 140),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
        }
        try VisualReference.assertMatchesReference(
            expandedIsland(counted((2, 5), 3))
                .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
            named: "live-activity-island-expanded-counts",
            size: CGSize(width: 360, height: 108),
            colorScheme: .dark,
            background: .black
        )
        let row = { (session: String, phase: String, status: String, plan: (Int, Int)?, workers: Int?) in
            TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: session,
                title: "Session \(session)", phase: phase, status: status, updatedAt: 0, deepLink: "",
                planCompleted: plan?.0, planTotal: plan?.1, workerCount: workers
            )
        }
        let aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 3, title: "Talaria", subtitle: "3 active", updatedAt: 0,
            rows: [
                row("A", "running", "Working", (2, 5), 3), row("B", "running", "Working", (0, 0), 1),
                row("C", "running", "Working", nil, nil), row("D", "completed", "Done", (0, 0), 0)
            ]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateRows(
                state: aggregate, isStale: false,
                limit: TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, spacing: 6
            ).padding(14),
            named: "live-activity-aggregate-rows-counts",
            size: CGSize(width: 360, height: 160),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
    }

    /// TAL-2336: the run's current call, named with its transcript row's icon and label, on the Lock Screen (relay-driven,
    /// so beside the tool count), in the expanded island and on the aggregate rows: running, failed with its outcome, a
    /// Talaria tool's mark, a connector's app, and a call an approval holds in the attention colour.
    func testCurrentToolReferences() throws {
        let call = { (kind: String, target: String, done: Bool) in AgentRunActivityTool(kind: kind, target: target, done: done) }
        var failed = call("shell", "npm test", true)
        failed.failed = true
        failed.outcome = AgentRunActivityTool.Outcome(key: "exit", tone: "error", count: 1)
        var connector = call("connector", "Send message", false)
        connector.app = AgentRunActivityTool.App(name: "Slack")
        let held = AgentRunActivityTool(kind: "shell", target: "npm publish", done: false, outcome: AgentRunActivityTool.Outcome(key: "pending_approval", tone: "attention"))
        let state = { (status: AgentRunActivityStatus, tool: AgentRunActivityTool, head: String?) in
            AgentRunActivityAttributes.ContentState(
                sessionID: "session-visual-reference", sessionTitle: "Talaria visual references", status: status,
                currentActivity: "Working", startedAt: AgentRunScenario.startedAt, updatedAt: AgentRunScenario.frozenClock,
                approvalHeadID: head, toolCount: 3, activityAt: AgentRunScenario.startedAt.addingTimeInterval(60), currentTool: tool
            )
        }
        for (name, tool, status, head) in [
            ("running", call("shell", "npm test", false), AgentRunActivityStatus.thinking, nil as String?),
            ("failed", failed, .thinking, nil),
            ("talaria", call("talaria", "session_send", true), .thinking, nil),
            ("connector", connector, .thinking, nil),
            ("approval", held, .waitingForApproval, AgentRunScenario.approvalHeadID),
        ] {
            try VisualReference.assertMatchesReference(
                AgentRunLockScreenView(state: state(status, tool, head), publisherID: "https://fixture.example")
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-lock-screen-tool-\(name)",
                size: CGSize(width: 360, height: 140),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
        }
        for (name, tool) in [("running", call("shell", "npm test", false)), ("failed", failed)] {
            try VisualReference.assertMatchesReference(
                expandedIsland(state(.thinking, tool, nil))
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-island-expanded-tool-\(name)",
                size: CGSize(width: 360, height: 108),
                colorScheme: .dark,
                background: .black
            )
        }
        let row = { (session: String, phase: String, status: String, tool: AgentRunActivityTool?) in
            TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: session,
                title: "Session \(session)", phase: phase, status: status, updatedAt: 0, deepLink: "", currentTool: tool
            )
        }
        let aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 3, title: "Talaria", subtitle: "3 active", updatedAt: 0,
            rows: [
                row("A", "running", "Working", call("shell", "npm test", false)), row("B", "running", "Working", connector),
                row("C", "running", "Working", nil), row("D", "completed", "Done", failed)
            ]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateRows(
                state: aggregate, isStale: false,
                limit: TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, spacing: 6
            ).padding(14),
            named: "live-activity-aggregate-rows-tool",
            size: CGSize(width: 360, height: 160),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
    }

    func testDynamicIslandExpandedReferences() throws {
        for scenario in AgentRunScenario.allCases {
            try VisualReference.assertMatchesReference(
                expandedIsland(scenario.state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-island-expanded-\(scenario.rawValue)",
                size: CGSize(width: 360, height: 108),
                colorScheme: .dark,
                background: .black
            )
        }
    }

    func testDynamicIslandCompactReferences() throws {
        for scenario in AgentRunScenario.allCases {
            try VisualReference.assertMatchesReference(
                compactIsland(scenario.state),
                named: "live-activity-island-compact-\(scenario.rawValue)",
                size: CGSize(width: 132, height: 32),
                colorScheme: .dark,
                background: .black
            )
        }
    }

    func testDynamicIslandMinimalReferences() throws {
        for scenario in AgentRunScenario.allCases {
            try VisualReference.assertMatchesReference(
                AgentRunIslandCompactMark(status: scenario.state.status),
                named: "live-activity-island-minimal-\(scenario.rawValue)",
                size: CGSize(width: 32, height: 32),
                colorScheme: .dark,
                background: .black
            )
        }
    }

    /// TAL-1463: the iPhone Duo's outer display. Its Lock Screen is wider than an iPhone 17's, and the vertical
    /// island's expanded bottom region is narrow, where the buttons keep their symbols alone.
    func testDuoOuterDisplayActionReferences() throws {
        for scenario in [AgentRunScenario.waiting, .input] {
            try VisualReference.assertMatchesReference(
                AgentRunLockScreenView(state: scenario.state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-lock-screen-\(scenario.rawValue)-duo-outer",
                size: CGSize(width: 436, height: 140),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
            try VisualReference.assertMatchesReference(
                AgentRunExpandedIslandBottomView(state: scenario.state),
                named: "live-activity-island-expanded-\(scenario.rawValue)-duo-outer",
                size: CGSize(width: 120, height: 60),
                colorScheme: .dark,
                background: .black
            )
        }
    }

    /// TAL-1488: "Denied · Undo" while Deny waits out its window, on the Lock Screen, the expanded island (iPhone and the
    /// Duo's narrow vertical island, where Undo keeps its symbol alone) and the aggregate's rows.
    func testDenyingReferences() throws {
        var state = AgentRunScenario.waiting.state
        state.isDenying = true
        try VisualReference.assertMatchesReference(
            AgentRunLockScreenView(state: state).environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
            named: "live-activity-lock-screen-denying",
            size: CGSize(width: 360, height: 140),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
        try VisualReference.assertMatchesReference(
            expandedIsland(state).environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
            named: "live-activity-island-expanded-denying",
            size: CGSize(width: 360, height: 108),
            colorScheme: .dark,
            background: .black
        )
        try VisualReference.assertMatchesReference(
            AgentRunExpandedIslandBottomView(state: state),
            named: "live-activity-island-expanded-denying-duo-outer",
            size: CGSize(width: 120, height: 60),
            colorScheme: .dark,
            background: .black
        )
        let row = { (session: String, isDenying: Bool?) in
            var row = TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: session,
                title: "Session \(session)", phase: "waiting_for_approval", status: "Approval", updatedAt: 0, deepLink: "",
                approvalHeadId: "head-\(session)"
            )
            row.isDenying = isDenying
            return row
        }
        let aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 2, title: "Talaria", subtitle: "2 active", updatedAt: 0,
            rows: [row("A", true), row("B", nil)]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateRows(state: aggregate, isStale: false, limit: 2, spacing: 6).padding(14),
            named: "live-activity-aggregate-rows-denying",
            size: CGSize(width: 360, height: 100),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
    }

    /// TAL-2037: the small family on the Apple Watch Smart Stack and CarPlay; the timer while working, the stale
    /// wording, the ask and the outcome, then the aggregate's header and first row.
    func testSmallFamilyReferences() throws {
        for scenario in [AgentRunScenario.running, .stale, .waiting, .completed] {
            try VisualReference.assertMatchesReference(
                AgentRunSmallView(state: scenario.state)
                    .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
                named: "live-activity-small-\(scenario.rawValue)",
                size: CGSize(width: 170, height: 72),
                colorScheme: .dark,
                background: AgentRunLiveActivityTheme.background
            )
        }
        let aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 2, title: "Talaria", subtitle: "2 active sessions", updatedAt: 0,
            rows: [
                TalariaAggregateActivityAttributes.ContentState.Row(
                    publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: "A",
                    title: "Session A", phase: "waiting_for_approval", status: "Approval", updatedAt: 0, deepLink: "",
                    approvalHeadId: "head-A"
                ),
            ]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateSmallView(state: aggregate, isStale: false),
            named: "live-activity-small-aggregate",
            size: CGSize(width: 170, height: 72),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
    }

    /// TAL-1463: the aggregate's Lock Screen rows; the first two waiting rows carry their buttons.
    func testAggregateRowsWithActionsReference() throws {
        let row = { (session: String, phase: String, status: String) in
            TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: session,
                title: "Session \(session)", phase: phase, status: status, updatedAt: 0, deepLink: "",
                approvalHeadId: phase == "waiting_for_approval" ? "head-\(session)" : nil
            )
        }
        let state = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 5, title: "Talaria", subtitle: "5 active", updatedAt: 0,
            rows: [
                row("A", "waiting_for_approval", "Approval"), row("B", "waiting_for_input", "Input"),
                row("C", "waiting_for_approval", "Approval"), row("D", "running", "Running"), row("E", "running", "Running")
            ]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateRows(
                state: state, isStale: false,
                limit: TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, spacing: 6
            ).padding(14),
            named: "live-activity-aggregate-rows-actions",
            size: CGSize(width: 360, height: 160),
            colorScheme: .dark,
            background: AgentRunLiveActivityTheme.background
        )
    }

    /// TAL-2036: from iOS 26 the Lock Screen activity sits on system material, light or dark with the system appearance,
    /// and Always-On mutes every status but work in progress. Both activities read the same palette.
    func testSystemMaterialLockScreenReferences() throws {
        let palette = { (dark: Bool, dimmed: Bool) in
            LiveActivityPalette(
                surface: .system, isDarkAppearance: dark, isFullColor: true, isLuminanceReduced: dimmed, increasedContrast: false
            )
        }
        let variants: [(String, LiveActivityPalette, ColorScheme, Color)] = [
            ("light", palette(false, false), .light, Color(white: 0.92)),
            ("always-on", palette(true, true), .dark, .black),
        ]
        for (variant, palette, colorScheme, background) in variants {
            for scenario in [AgentRunScenario.running, .waiting, .failed] {
                try VisualReference.assertMatchesReference(
                    AgentRunLockScreenView(state: scenario.state)
                        .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock)
                        .environment(\.liveActivityPalette, palette),
                    named: "live-activity-lock-screen-\(scenario.rawValue)-\(variant)",
                    size: CGSize(width: 360, height: 140),
                    colorScheme: colorScheme,
                    background: background
                )
            }
        }
        let row = { (session: String, phase: String, status: String) in
            TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: "https://fixture.example", publisherLabel: "fixture", sessionId: session,
                title: "Session \(session)", phase: phase, status: status, updatedAt: 0, deepLink: ""
            )
        }
        let state = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 3, title: "Talaria", subtitle: "3 active", updatedAt: 0,
            rows: [row("A", "failed", "Failed"), row("B", "running", "Running"), row("C", "completed", "Done")]
        )
        try VisualReference.assertMatchesReference(
            TalariaAggregateRows(
                state: state, isStale: false,
                limit: TalariaAggregateLiveActivityPresentation.lockScreenRowLimit, spacing: 6
            )
            .padding(14)
            .environment(\.liveActivityPalette, palette(false, false)),
            named: "live-activity-aggregate-rows-light",
            size: CGSize(width: 360, height: 90),
            colorScheme: .light,
            background: Color(white: 0.92)
        )
    }

    /// The Lock Screen title, activity line and excerpt all scale, so an
    /// accessibility text size is where its layout gives out first.
    func testLockScreenAccessibilityTextSizeReference() throws {
        try VisualReference.assertMatchesReference(
            AgentRunLockScreenView(state: AgentRunScenario.waiting.state)
                .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock),
            named: "live-activity-lock-screen-waiting-accessibility3",
            size: CGSize(width: 360, height: 420),
            colorScheme: .dark,
            dynamicTypeSize: .accessibility3,
            background: AgentRunLiveActivityTheme.background
        )
    }

    /// Stand-in for the Dynamic Island's expanded regions. `DynamicIsland` only
    /// lays its regions out inside the system presenter, so the reference
    /// composes the same three region views in the same order instead.
    private func expandedIsland(_ state: AgentRunActivityAttributes.ContentState) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                AgentRunIslandBadge(status: state.status)
                    .padding(.leading, 18)

                Spacer(minLength: 12)

                AgentRunIslandStatusView(state: state)
                    .padding(.trailing, 18)
            }

            AgentRunExpandedIslandBottomView(state: state)
        }
        .padding(.vertical, 10)
    }

    private func compactIsland(_ state: AgentRunActivityAttributes.ContentState) -> some View {
        HStack(spacing: 8) {
            AgentRunIslandCompactMark(status: state.status)
            AgentRunIslandCompactTrailing(state: state)
        }
    }
}

/// Fixed Live Activity content states. Every timestamp is a constant and the
/// running timer reads `agentRunFrozenClock`, so a render is reproducible.
enum AgentRunScenario: String, CaseIterable {
    case running
    case waiting
    case input
    case stale
    case completed
    case failed
    case cancelled

    static let startedAt = Date(timeIntervalSince1970: 1_760_000_000)
    static let frozenClock = startedAt.addingTimeInterval(125)
    static let approvalHeadID = "visual-approval-head"
    static let approvalText = "rm -rf build/cache"

    var state: AgentRunActivityAttributes.ContentState {
        switch self {
        case .running:
            makeState(
                status: .responding,
                currentActivity: "Writing response",
                responseExcerpt: "Reworked the transcript cache so a reconnect keeps the streamed turn."
            )
        case .waiting:
            makeState(
                status: .waitingForApproval, currentActivity: "Waiting for approval",
                approvalHeadID: Self.approvalHeadID, approvalText: Self.approvalText
            )
        case .input:
            makeState(status: .waitingForClarification, currentActivity: "Input")
        case .stale:
            makeState(
                status: .usingTool,
                currentActivity: "Using ripgrep",
                responseExcerpt: "Searching the workspace for the failing fixture.",
                isStale: true
            )
        case .completed:
            makeState(
                status: .complete,
                currentActivity: "Complete",
                responseExcerpt: "Landed the fix and the regression test now passes.",
                isFinal: true
            )
        case .failed:
            makeState(
                status: .failed,
                currentActivity: "Failed",
                isFinal: true,
                errorSummary: "The server closed the stream before the turn finished."
            )
        case .cancelled:
            makeState(status: .cancelled, currentActivity: "Cancelled", isFinal: true)
        }
    }

    private func makeState(
        status: AgentRunActivityStatus,
        currentActivity: String,
        responseExcerpt: String = "",
        isStale: Bool = false,
        isFinal: Bool = false,
        errorSummary: String? = nil,
        approvalHeadID: String? = nil,
        approvalText: String? = nil
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: "session-visual-reference",
            sessionTitle: "Talaria visual references",
            status: status,
            currentActivity: currentActivity,
            responseExcerpt: responseExcerpt,
            startedAt: Self.startedAt,
            updatedAt: Self.frozenClock,
            isStale: isStale,
            isFinal: isFinal,
            errorSummary: errorSummary,
            approvalHeadID: approvalHeadID,
            approvalText: approvalText
        )
    }
}

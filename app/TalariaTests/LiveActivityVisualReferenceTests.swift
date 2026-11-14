import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Visual references only. Behavioural assertions about Live Activity state
/// live in `LiveActivityTests`; nothing here asserts on anything but pixels.
@MainActor
final class LiveActivityVisualReferenceTests: XCTestCase {
    func testContinuingBackgroundWorkScreenshots() throws {
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "background-visual", sessionTitle: "Review project changes", startedAt: AgentRunScenario.startedAt
        )
        let previous = AgentRunActivityStateReducer.final(
            status: .complete, activity: "Response complete", state: initial
        )
        try attachStateScreenshot(previous, named: "TAL-1520-before-parent-done")
        let manager = AgentLiveActivityManager(updateActivity: { _ in })
        manager.start(sessionID: "background-visual", sessionTitle: "Review project changes", streamID: "parent", publisherURL: URL(string: "https://fixture.example")!, startedAt: AgentRunScenario.startedAt)
        LiveActivityReconciler.applySessionPhase("running", sessionID: "background-visual", streamID: "parent", manager: manager)
        let continuing = try XCTUnwrap(manager.currentState)
        XCTAssertFalse(continuing.isFinal)
        XCTAssertEqual(continuing.currentActivity, "Working")
        try attachStateScreenshot(continuing, named: "TAL-1520-after-background-working")
        LiveActivityReconciler.applySessionPhase("completed", sessionID: "background-visual", streamID: "parent", manager: manager)
    }

    func testInputWaitLiveActivityScreenshots() throws {
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "input-visual-test", sessionTitle: "Input needed",
            startedAt: AgentRunScenario.startedAt
        )
        let state = AgentRunActivityStateReducer.waitingForClarification(
            state: initial, now: AgentRunScenario.frozenClock
        )
        try attachStateScreenshot(state, named: "Input in per-session Live Activity")
    }

    func testStreamingPrefixScreenshots() throws {
        let manager = AgentLiveActivityManager(
            updateActivity: { _ in },
            setInterimAssistant: {
                AgentRunActivityStateReducer.settingInterimAssistant($0, on: $1, now: AgentRunScenario.frozenClock)
            }
        )
        manager.start(
            sessionID: "streaming-visual-fixture", sessionTitle: "Review project changes",
            streamID: "streaming-visual-stream", publisherURL: URL(string: "https://fixture.example")!,
            startedAt: AgentRunScenario.startedAt
        )
        manager.update(.token(String(repeating: "The project changes are ready for review. ", count: 5)))
        let before = try XCTUnwrap(manager.currentState)
        try attachStateScreenshot(before, named: "Excerpt full before tail")
        for _ in 0..<2_000 { manager.update(.token(" more text")) }
        let after = try XCTUnwrap(manager.currentState)
        XCTAssertEqual(before, after)
        try attachStateScreenshot(after, named: "Excerpt unchanged after 2000 tokens")
    }

    private func attachStateScreenshot(_ state: AgentRunActivityAttributes.ContentState, named name: String) throws {
        let renderer = ImageRenderer(content:
            VStack(spacing: 16) {
                AgentRunLockScreenView(state: state)
                    .frame(width: 360, height: 140)
                expandedIsland(state)
                    .frame(width: 360, height: 108)
                compactIsland(state)
                    .frame(width: 132, height: 32)
            }
            .environment(\.agentRunFrozenClock, AgentRunScenario.frozenClock)
            .environment(\.colorScheme, .dark)
            .padding(16)
            .background(Color.black)
        )
        renderer.scale = 3
        let screenshot = XCTAttachment(image: try XCTUnwrap(renderer.uiImage))
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

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

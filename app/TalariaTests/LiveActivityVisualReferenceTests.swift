import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Visual references only. Behavioural assertions about Live Activity state
/// live in `LiveActivityTests`; nothing here asserts on anything but pixels.
@MainActor
final class LiveActivityVisualReferenceTests: XCTestCase {
    func testInputWaitLiveActivityScreenshots() throws {
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "input-visual-test", sessionTitle: "Input needed",
            startedAt: AgentRunScenario.startedAt
        )
        let state = AgentRunActivityStateReducer.waitingForClarification(
            state: initial, now: AgentRunScenario.frozenClock
        )
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
        screenshot.name = "Input in per-session Live Activity"
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
    case stale
    case completed
    case failed
    case cancelled

    static let startedAt = Date(timeIntervalSince1970: 1_760_000_000)
    static let frozenClock = startedAt.addingTimeInterval(125)

    var state: AgentRunActivityAttributes.ContentState {
        switch self {
        case .running:
            makeState(
                status: .responding,
                currentActivity: "Writing response",
                responseExcerpt: "Reworked the transcript cache so a reconnect keeps the streamed turn."
            )
        case .waiting:
            makeState(status: .waitingForApproval, currentActivity: "Waiting for approval")
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
        errorSummary: String? = nil
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
            errorSummary: errorSummary
        )
    }
}

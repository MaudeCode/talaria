import SwiftUI
import UIKit
import TalariaKit


@MainActor
final class NavigationBarLeadingMarginViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        applyMargin()
    }

    func applyMargin() {
        guard let navigationBar = navigationController?.navigationBar else { return }
        var margins = navigationBar.directionalLayoutMargins
        margins.leading = 16
        navigationBar.directionalLayoutMargins = margins
    }
}

struct SessionListRowActions {
    let retryLoad: () -> Void
    let open: (SessionSummary) -> Void
    let togglePinned: (SessionSummary) -> Void
    let archive: (SessionSummary) -> Void
    let delete: (SessionSummary) -> Void
    let rename: (SessionSummary) -> Void
    let duplicate: (SessionSummary) -> Void
    let move: (SessionSummary, String?) -> Void
    let createProject: (SessionSummary) -> Void
    let refreshProjects: () -> Void
    let export: (SessionSummary, SessionExportFormat) -> Void
}

enum SessionListMotion {
    static func disclosureAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .smooth(duration: 0.28, extraBounce: 0)
    }

    static func pressAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? .easeOut(duration: 0.12) : .smooth(duration: 0.18, extraBounce: 0)
    }

    static func sessionMutationAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0)
    }

    static func sessionRowTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }

    static func disclosureContentTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }
}

/// Long-press menu on the session-list avatar: switch the active server (the
/// active one marked + disabled, mirroring `SessionProjectMoveMenu`'s checkmark
/// idiom), plus shortcuts into #17's add-server flow and the Settings server
/// list (#283). Holds no switching logic — it calls back into the tested #17
/// `AuthManager.switchActiveServer` action and the existing navigation.

extension View {
    func sessionsScreenListRow(insets: EdgeInsets = EdgeInsets()) -> some View {
        listRowInsets(insets)
            .listRowSeparator(.hidden)
            .listRowBackground(Color(.systemBackground))
    }

    func sessionsChromeGlass<S: InsettableShape>(
        isInteractive: Bool = false,
        tint: Color? = nil,
        fallbackMaterial: Material = .ultraThinMaterial,
        in shape: S
    ) -> some View {
        adaptiveGlass(
            .regular,
            isInteractive: isInteractive,
            tint: tint,
            fallbackMaterial: fallbackMaterial,
            in: shape
        )
    }
}

/// Sheet item for a finished session export: the temp file offered to the
/// share sheet. Identity is the file URL, which is unique per export.
struct SessionExportShareItem: Identifiable {
    let fileURL: URL

    var id: String { fileURL.absoluteString }
}

/// Minimal `UIActivityViewController` wrapper — the app has no other share
/// surface and `ShareLink` can't be presented programmatically after an async
/// download finishes. Cleanup of the temp file happens in the sheet's
/// `onDismiss`, which runs after the activity UI is gone in both the
/// completed and cancelled paths.

struct SessionListFloatingChatButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isPressed = isEnabled && configuration.isPressed

        configuration.label
            .scaleEffect(reduceMotion ? 1 : (isPressed ? 0.975 : 1))
            .opacity(isPressed ? 0.96 : 1)
            .shadow(
                color: .black.opacity(isPressed ? 0.10 : 0.18),
                radius: isPressed ? 8 : 18,
                y: isPressed ? 3 : 8
            )
            .animation(SessionListMotion.pressAnimation(reduceMotion: reduceMotion), value: isPressed)
    }
}



struct SidebarSubrowSelectionStyle: ViewModifier {
    let isSelected: Bool

    func body(content: Content) -> some View {
        content
            .padding(.leading, 18)
            .padding(.trailing, 10)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(0.10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Color.accentColor.opacity(0.20), lineWidth: 1)
                        }
                }
            }
    }
}

extension View {
    func sidebarSubrowSelectionStyle(isSelected: Bool) -> some View {
        modifier(SidebarSubrowSelectionStyle(isSelected: isSelected))
    }
}



extension Color {
    init?(hexString: String?) {
        guard let hexString else { return nil }

        var trimmed = hexString
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("#") {
            trimmed.removeFirst()
        }

        let expanded: String
        switch trimmed.count {
        case 3:
            expanded = trimmed.map { "\($0)\($0)" }.joined()
        case 6:
            expanded = trimmed
        default:
            return nil
        }

        guard let value = UInt64(expanded, radix: 16) else { return nil }

        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}




struct SessionRowSkeletonConfiguration: Identifiable {
    let id: String
    let title: String
    let messageCount: String
    let workspace: String
    let relativeDate: String

    static let loadingRows: [SessionRowSkeletonConfiguration] = [
        SessionRowSkeletonConfiguration(
            id: "recent-build",
            title: "Review latest mobile build notes",
            messageCount: "12 messages",
            workspace: "talaria",
            relativeDate: "5m"
        ),
        SessionRowSkeletonConfiguration(
            id: "polish-pass",
            title: "Plan the next polish pass",
            messageCount: "8 messages",
            workspace: "design",
            relativeDate: "1h"
        ),
        SessionRowSkeletonConfiguration(
            id: "streaming-check",
            title: "Streaming behavior investigation",
            messageCount: "24 messages",
            workspace: "webui",
            relativeDate: "3h"
        ),
        SessionRowSkeletonConfiguration(
            id: "testflight",
            title: "TestFlight validation checklist",
            messageCount: "6 messages",
            workspace: "release",
            relativeDate: "1d"
        ),
        SessionRowSkeletonConfiguration(
            id: "followup",
            title: "Follow-up implementation details",
            messageCount: "17 messages",
            workspace: "notes",
            relativeDate: "2d"
        )
    ]
}

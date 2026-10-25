import SwiftUI
import UIKit
import TalariaKit


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
    /// Stops a run card's live run (TAL-1460).
    let stopRun: (SessionSummary) -> Void
}

/// Reads the hinge for the session list root, the only place the App does (TAL-1460). The UI fixture's tent pose
/// stands in for it, since no simulator pose opens the hinge with the outer display active.
struct SessionListHingeReader: ViewModifier {
    @Binding var status: SessionRunMonitor.HingeStatus?

    func body(content: Content) -> some View {
        if Self.forcesTentHinge {
            content.onAppear { status = .partiallyOpen }
        } else if #available(iOS 27.1, *) {
            content.onHingeChange { _, context in
                status = context.hinge.map { Self.status($0.status) }
            }
        } else {
            content
        }
    }

    private static var forcesTentHinge: Bool {
        #if DEBUG
        UITestFixtureEnvironment.forcesTentHinge
        #else
        false
        #endif
    }

    @available(iOS 27.1, *)
    private static func status(_ status: DeviceHinge.Status) -> SessionRunMonitor.HingeStatus {
        switch status {
        case .partiallyOpen: .partiallyOpen
        case .fullyOpen: .fullyOpen
        default: .closed
        }
    }
}

enum SessionListMotion {
    /// The sidebar column and its rigid chat pane move on this curve.
    static let foldDuration: TimeInterval = 0.35

    static func foldAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: foldDuration, extraBounce: 0)
    }

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

    /// Rows switching between list rows and run cards (TAL-1460): Reduce Motion crossfades them in place.
    static func rowStyleAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .snappy(duration: 0.24, extraBounce: 0)
    }

    static func toastTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom))
    }
}

/// Offers to undo the latest chat archive (TAL-443), worded like the Kanban
/// archive-undo banner. A failed undo stays with Try Again until it succeeds or
/// is dismissed.
struct SessionArchiveUndoToast: View {
    let undo: SessionArchiveUndo
    let undoArchive: () -> Void
    let dismiss: () -> Void

    var body: some View {
        let statusText = undo.undoFailed ? String(localized: "Update failed") : String(localized: "Chat archived")
        HStack(spacing: 12) {
            Label(statusText, systemImage: undo.undoFailed ? "exclamationmark.circle" : "archivebox")
                .lineLimit(2)
            Spacer(minLength: 0)
            Button(undo.undoFailed ? "Try Again" : "Undo", action: undoArchive)
                .fontWeight(.semibold)
            if undo.undoFailed {
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                }
                .accessibilityLabel("Dismiss")
            }
        }
        .font(.footnote)
        .padding(.horizontal)
        .padding(.vertical, 12)
        .adaptiveGlass(in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(statusText))
    }
}

extension View {
    func sessionsScreenListRow(insets: EdgeInsets = EdgeInsets()) -> some View {
        listRowInsets(insets)
            .listRowSeparator(.hidden)
            .listRowBackground(Color(.systemBackground))
    }

}

/// Sheet item for a finished session export: the temp file offered to the
/// share sheet. Identity is the file URL, which is unique per export.
struct SessionExportShareItem: Identifiable {
    let fileURL: URL

    var id: String { fileURL.absoluteString }
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

import SwiftUI
import UIKit
import TalariaKit
import UniformTypeIdentifiers

/// A sidebar navigation drag is distinct from text/files dropped into a composer.
enum SidebarChatDrag {
    static let type = UTType(exportedAs: "dev.kil.talaria.sidebar-chat", conformingTo: .data)
    static let typeIdentifier = type.identifier

    /// One provider, two destinations: the conversation opens the chat beside, and with `opensWindow` the screen edge
    /// or the other Split View side opens it in a new window (TAL-2389).
    static func provider(for session: SessionSummary, opensWindow: Bool = false) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.suggestedName = session.title
        guard let id = session.sessionId else { return provider }
        provider.registerDataRepresentation(forTypeIdentifier: typeIdentifier, visibility: .ownProcess) { completion in
            completion(Data(id.utf8), nil)
            return nil
        }
        if opensWindow {
            let activity = OpenWindowTarget.session(id).activity(title: SessionRowPresentation.displayTitle(for: session))
            provider.registerObject(activity, visibility: .all)
        }
        return provider
    }

    /// A lifted row on its way to the conversation. Hovering there shows it beside the primary; the drop keeps it
    /// shown until navigation opens it beside the primary, or refuses it and the open secondary returns.
    struct Preview: Equatable {
        var session: SessionSummary?
        var isOverChat = false
        var isDropped = false

        var shown: SessionSummary? { isOverChat || isDropped ? session : nil }
    }
}

/// A sidebar row's menu item that opens its chat or section in its own window (TAL-2389).
struct OpenInNewWindowButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) { Label("Open in New Window", systemImage: "macwindow.badge.plus") }
    }
}

/// The conversation's one destination for a sidebar chat drag. SwiftUI gives a drag to the innermost drop destination
/// under it, so a composer inside the conversation forwards sidebar chats here instead of refusing them. One instance
/// per chat, so handing it down the environment invalidates nothing.
@MainActor
final class SidebarChatDropDelegate: DropDelegate {
    var hover: (Bool) -> Void = { _ in }
    var drop: ([NSItemProvider]) -> Bool = { _ in false }

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [SidebarChatDrag.type]) }
    func dropEntered(info: DropInfo) { hover(true) }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .copy) }
    func dropExited(info: DropInfo) { hover(false) }
    func performDrop(info: DropInfo) -> Bool { drop(info.itemProviders(for: [SidebarChatDrag.type])) }
}

extension EnvironmentValues {
    @Entry var sidebarChatDropDelegate: SidebarChatDropDelegate?
}

struct SessionListRowActions {
    let retryLoad: () -> Void
    let open: (SessionSummary, String) -> Void
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
    var openBeside: (SessionSummary) -> (() -> Void)? = { _ in nil }
    /// Opens the chat in its own window, or brings forward the window already showing it (TAL-2389).
    var openInNewWindow: (SessionSummary) -> (() -> Void)? = { _ in nil }
    /// A row lifted for a chat drag.
    var sidebarChatLifted: (SessionSummary) -> Void = { _ in }
}

/// The session list root's one hinge read (TAL-1460): `AppSidebarController` observes its window's hinge and reports
/// it here. The UI fixture's tent pose stands in for it, since no simulator pose opens the hinge with the outer display
/// active.
struct SessionListHingeReader: ViewModifier {
    @Binding var status: SessionRunMonitor.HingeStatus?

    func body(content: Content) -> some View {
        content.onAppear { if Self.forcesTentHinge { status = .partiallyOpen } }
    }

    func admit(_ hinge: SessionRunMonitor.HingeStatus?) {
        guard !Self.forcesTentHinge, status != hinge else { return }
        status = hinge
    }

    private static var forcesTentHinge: Bool {
        #if DEBUG
        UITestFixtureEnvironment.forcesTentHinge
        #else
        false
        #endif
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

/// Under Reduce Motion the native sidebar column jumps: UIKit slides it on its own whenever its animations are on as
/// it applies the change, and it applies it on a turn after SwiftUI's update, not in it. Animations stay off until the
/// native column reports the new visibility, and come back once that turn has committed.
@MainActor final class NativeColumnJump {
    // Each restore holds this strongly and runs once: animations come back even after the owning view is gone.
    private var pending: (target: NavigationSplitViewVisibility, animates: Bool, generation: Int)?
    private var generation = 0

    /// Turns animations off for a change to `target` the column is about to make; `changes` is false when it shows
    /// `target` already, so there is no report to wait for.
    func begin(target: NavigationSplitViewVisibility, changes: Bool) {
        let animates = pending?.animates ?? UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(false)
        generation += 1
        let generation = generation
        pending = (target, animates, generation)
        if changes {
            // ponytail: 1 s bound for a report that never comes; nothing UIKit draws is meant to wait that long.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.restore(generation) }
        } else {
            restoreAfterCommit(generation)
        }
    }

    /// The native column now shows `visibility`.
    func columnReported(_ visibility: NavigationSplitViewVisibility) {
        guard let pending, pending.target == visibility else { return }
        restoreAfterCommit(pending.generation)
    }

    private func restoreAfterCommit(_ generation: Int) {
        let observer = CFRunLoopObserverCreateWithHandler(
            nil, CFRunLoopActivity.beforeWaiting.rawValue | CFRunLoopActivity.exit.rawValue, false, .max
        ) { _, _ in MainActor.assumeIsolated { self.restore(generation) } }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    private func restore(_ generation: Int) {
        guard let pending, pending.generation == generation else { return }
        self.pending = nil
        UIView.setAnimationsEnabled(pending.animates)
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
        sessionsScreenListRow(insets: insets, background: Color(.systemBackground))
    }

    /// The same row with its own List cell background, for a background that also measures the cell.
    func sessionsScreenListRow(insets: EdgeInsets, background: some View) -> some View {
        listRowInsets(insets)
            .listRowSeparator(.hidden)
            .listRowBackground(background)
    }

}

/// Sheet item for a finished session export: the temp file offered to the
/// share sheet. Identity is the file URL, which is unique per export.
struct SessionExportShareItem: Identifiable {
    let fileURL: URL

    var id: String { fileURL.absoluteString }
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

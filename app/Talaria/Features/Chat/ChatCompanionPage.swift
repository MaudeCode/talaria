import SwiftUI
import UIKit
import TalariaKit

/// TAL-1458: the file the agent is working on, on the page beside the chat. It follows the server's `focus_path` from
/// file to file; a file chosen in its browser pins it until Follow or the next run. Like the Files inspector, it keeps
/// its own navigation controller, so the browser pushes and the file's toolbar stay on this page: a SwiftUI stack here
/// would join the chat's.
struct ChatCompanionPage: UIViewControllerRepresentable {
    let viewModel: ChatViewModel
    let session: SessionSummary
    let server: URL
    let onAPIError: (Error) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UINavigationController {
        let file = ChatCompanionFile(viewModel: viewModel, session: session, server: server, onAPIError: onAPIError)
        let navigation = UINavigationController(rootViewController: UIHostingController(rootView: file))
        navigation.delegate = context.coordinator
        context.coordinator.viewModel = viewModel
        showBrowser(viewModel.companionFocus.browserPath, in: navigation, animated: false)
        return navigation
    }

    func updateUIViewController(_ navigation: UINavigationController, context: Context) {
        context.coordinator.viewModel = viewModel
        showBrowser(viewModel.companionFocus.browserPath, in: navigation, animated: true)
    }

    /// The browser over the file while the chat's companion focus names a directory; the file alone otherwise.
    private func showBrowser(_ path: String?, in navigation: UINavigationController, animated: Bool) {
        let isShown = navigation.viewControllers.count > 1
        if let path, !isShown {
            let browser = FileBrowserView(
                session: session,
                server: server,
                onAPIError: onAPIError,
                initialPath: path,
                onPathChange: { [viewModel] in viewModel.showCompanionBrowser(at: $0) },
                onOpenFile: { [viewModel] entry in
                    guard let path = entry.path else { return }
                    viewModel.pinCompanionFile(path)
                }
            )
            navigation.pushViewController(UIHostingController(rootView: browser), animated: animated)
        } else if path == nil, isShown {
            navigation.popToRootViewController(animated: animated)
        }
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate {
        var viewModel: ChatViewModel?

        /// The browser's back button closes it.
        func navigationController(_ navigation: UINavigationController, didShow controller: UIViewController, animated: Bool) {
            guard navigation.viewControllers.count == 1, viewModel?.companionFocus.browserPath != nil else { return }
            viewModel?.showCompanionBrowser(at: nil)
        }
    }
}

/// The companion page's file: the followed or pinned file, or its latest change, with Follow and Changes toggles and
/// the Files browser.
private struct ChatCompanionFile: View {
    let viewModel: ChatViewModel
    let session: SessionSummary
    let server: URL
    let onAPIError: (Error) -> Void
    @State private var showsChanges = false

    var body: some View {
        let focus = viewModel.companionFocus
        Group {
            if let path = focus.path {
                if showsChanges, let editDiff = focus.shownEditDiff {
                    ScrollView {
                        EditDiffHunks(editDiff: editDiff)
                            .padding()
                    }
                    .navigationTitle(Self.name(of: path))
                    .navigationBarTitleDisplayMode(.inline)
                } else {
                    FilePreviewView(session: session, server: server, entry: WorkspaceEntry(name: Self.name(of: path), path: path), onAPIError: onAPIError)
                        // A followed file reloads after each edit lands; a pinned one only when it changes.
                        .id(focus.isFollowing ? "\(path)#\(focus.editRevision)" : path)
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                Toggle(isOn: following(focus)) {
                    Label("Follow", systemImage: "scope")
                }
                .toggleStyle(.button)
                .labelStyle(.titleAndIcon)
                // The browser pushes on this page, beside the chat, rather than over it.
                Button {
                    viewModel.showCompanionBrowser(at: ".")
                } label: {
                    Label("Files", systemImage: "folder")
                }
                if focus.shownEditDiff != nil {
                    Toggle(isOn: $showsChanges) {
                        Label("Changes", systemImage: "plusminus")
                    }
                    .toggleStyle(.button)
                    .labelStyle(.titleAndIcon)
                }
            }
        }
    }

    /// On follows the agent's file; off pins the one shown.
    private func following(_ focus: ChatCompanionFocus) -> Binding<Bool> {
        Binding(
            get: { focus.isFollowing },
            set: { follows in
                if follows {
                    viewModel.followCompanionFocus()
                } else if let path = focus.path {
                    viewModel.pinCompanionFile(path)
                }
            }
        )
    }

    private static func name(of path: String) -> String {
        (path as NSString).lastPathComponent
    }
}

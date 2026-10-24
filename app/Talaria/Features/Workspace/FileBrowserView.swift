import SwiftUI
import UIKit
import TalariaKit

extension EnvironmentValues {
    @Entry var workspaceSurface = Color(.systemBackground)
}

/// Files owns its navigation controller so previews push inside the inspector, beside the chat.
struct FilesInspectorContent: UIViewControllerRepresentable {
    let session: SessionSummary
    let server: URL
    let onAPIError: (Error) -> Void
    let onClose: () -> Void
    let isPresented: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> NavigationController {
        let navigation = NavigationController()
        navigation.inspectorIsPresented = isPresented
        navigation.view.backgroundColor = .secondarySystemBackground
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.shadowColor = .clear
        navigation.navigationBar.standardAppearance = appearance
        navigation.navigationBar.scrollEdgeAppearance = appearance
        navigation.navigationBar.compactAppearance = appearance
        navigation.navigationBar.compactScrollEdgeAppearance = appearance
        navigation.navigationBar.isTranslucent = true
        let browser = FileBrowserView(
            session: session, server: server, onAPIError: onAPIError,
            inspectorSearch: context.coordinator
        ) { [weak navigation] entry in
            let preview = FilePreviewView(session: session, server: server, entry: entry, onAPIError: onAPIError)
            navigation?.pushViewController(Self.host(preview, appearance: appearance), animated: true)
        }
        let host = Self.host(browser, appearance: appearance)
        host.navigationItem.title = String(localized: "Files")
        host.navigationItem.largeTitleDisplayMode = .never
        let search = UISearchController(searchResultsController: nil)
        search.searchBar.placeholder = String(localized: "Search files")
        search.obscuresBackgroundDuringPresentation = false
        search.searchResultsUpdater = context.coordinator
        host.navigationItem.searchController = search
        host.definesPresentationContext = true
        if #available(iOS 26, *) {
            host.navigationItem.preferredSearchBarPlacement = .integratedButton
            host.navigationItem.searchBarPlacementAllowsToolbarIntegration = false
        }
        let close = UIBarButtonItem(image: UIImage(systemName: "xmark"), primaryAction: UIAction { _ in onClose() })
        close.accessibilityLabel = String(localized: "Close Files")
        host.navigationItem.rightBarButtonItems = [close]
        navigation.viewControllers = [host]
        return navigation
    }

    /// Browser and every pushed page use the same full-height inspector surface. The column already
    /// excludes the window toolbar; neither its trailing nor bottom inset should shrink a hosted page.
    private static func host(_ content: some View, appearance: UINavigationBarAppearance) -> UIViewController {
        let host = UIHostingController(rootView: content
            .environment(\.workspaceSurface, Color(.secondarySystemBackground))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.secondarySystemBackground).ignoresSafeArea())
            .ignoresSafeArea(.container, edges: [.trailing, .bottom])
            .toolbarBackground(.hidden, for: .navigationBar))
        host.view.backgroundColor = .secondarySystemBackground
        host.navigationItem.standardAppearance = appearance
        host.navigationItem.scrollEdgeAppearance = appearance
        host.navigationItem.compactAppearance = appearance
        host.navigationItem.compactScrollEdgeAppearance = appearance
        return host
    }

    // The detail column recreates the inspector for another session.
    func updateUIViewController(_ controller: NavigationController, context: Context) {
        controller.inspectorIsPresented = isPresented
        controller.reconcilePresentation()
    }

    /// Extends the inspector's existing navigation controller to consume the same presentation decision
    /// after UIKit restores its column during rotation. This changes no SwiftUI navigation identity.
    final class NavigationController: UINavigationController {
        var inspectorIsPresented = false
        private var isReconciling = false

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            reconcilePresentation()
        }

        func reconcilePresentation() {
            guard #available(iOS 26, *), let split = splitViewController else { return }
            // The outer split also owns the reserved vertical-bar background.
            split.view.backgroundColor = inspectorIsPresented ? .secondarySystemBackground : .systemBackground
            guard !inspectorIsPresented, !isReconciling, split.isShowing(.inspector) else { return }
            isReconciling = true
            UIView.performWithoutAnimation { split.hide(.inspector) }
            isReconciling = false
        }
    }

    @Observable
    final class Coordinator: NSObject, UISearchResultsUpdating {
        var searchText = ""

        func updateSearchResults(for searchController: UISearchController) {
            searchText = searchController.searchBar.text ?? ""
        }
    }
}

struct FileBrowserView: View {
    let onAPIError: (Error) -> Void
    /// Opens a file in place of a navigation link, for a host that pushes it itself.
    private let onOpenFile: ((WorkspaceEntry) -> Void)?
    @Environment(\.workspaceSurface) private var background
    private let inspectorSearch: FilesInspectorContent.Coordinator?
    /// The directory the browser opens at, and where it reports each one it shows, for a host that keeps it (TAL-1458).
    private let initialPath: String
    private let onPathChange: ((String) -> Void)?

    private let session: SessionSummary
    private let server: URL
    @State private var viewModel: FileBrowserViewModel
    @State private var searchText = ""

    init(
        session: SessionSummary,
        server: URL,
        onAPIError: @escaping (Error) -> Void,
        initialPath: String = ".",
        onPathChange: ((String) -> Void)? = nil,
        inspectorSearch: FilesInspectorContent.Coordinator? = nil,
        onOpenFile: ((WorkspaceEntry) -> Void)? = nil
    ) {
        self.session = session
        self.server = server
        self.onAPIError = onAPIError
        self.initialPath = initialPath
        self.onPathChange = onPathChange
        self.onOpenFile = onOpenFile
        self.inspectorSearch = inspectorSearch
        _viewModel = State(initialValue: FileBrowserViewModel(session: session, server: server))
    }

    var body: some View {
        Group {
            if inspectorSearch != nil {
                if #available(iOS 26, *) {
                    browserSurface.scrollEdgeEffectHidden(true, for: .top)
                } else {
                    browserSurface
                }
            } else {
                browserSurface
                    .navigationTitle("Files")
                    .navigationBarTitleDisplayMode(.inline)
                    .searchable(text: $searchText, placement: .toolbar, prompt: "Search files")
                    .minimizingSearchToolbar()
            }
        }
        .task { await loadInitialRootIfNeeded() }
        .onChange(of: viewModel.currentPath) { _, path in onPathChange?(path) }
    }

    private var browserSurface: some View {
        VStack(spacing: 0) {
            pathHeader
            content
                .adaptiveReadableScrollContent(maxWidth: AdaptiveReadableContentWidth.workspace)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(background.ignoresSafeArea())
    }

    private var query: String { inspectorSearch?.searchText ?? searchText }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.entries.isEmpty {
            ProgressView("Loading files...")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage = viewModel.errorMessage, viewModel.entries.isEmpty {
            ContentUnavailableView {
                Label("Could Not Load Files", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await retryLastLoad() }
                }
            }
        } else if visibleEntries.isEmpty {
            ContentUnavailableView {
                Label(query.isEmpty ? "No Files" : "No Matches", systemImage: query.isEmpty ? "folder" : "magnifyingglass")
            } description: {
                if query.isEmpty && !viewModel.isAtRoot {
                    Text(viewModel.currentPath)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if !query.isEmpty {
                    Text("Try a different file name or path.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            List(visibleEntries) { entry in
                Group {
                    if entry.isBrowsableDirectory {
                        Button {
                            Task { await load(path: entry.path ?? ".") }
                        } label: {
                            FileBrowserRow(entry: entry, showsDisclosure: true)
                        }
                        .buttonStyle(.plain)
                    } else if entry.path != nil, let onOpenFile {
                        Button {
                            onOpenFile(entry)
                        } label: {
                            FileBrowserRow(entry: entry, showsDisclosure: true)
                        }
                        .buttonStyle(.plain)
                    } else if entry.path != nil {
                        NavigationLink {
                            FilePreviewView(session: session, server: server, entry: entry, onAPIError: onAPIError)
                        } label: {
                            FileBrowserRow(entry: entry, showsDisclosure: false)
                        }
                    } else {
                        FileBrowserRow(entry: entry, showsDisclosure: false)
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 44)
            .refreshable {
                await reloadCurrentPath()
            }
            .refreshesLive(on: .runEnded, showsStatus: false) {
                await reloadCurrentPath()
            }
            .listStyle(.plain)
            .safeAreaInset(edge: .top, spacing: 0) {
                if viewModel.isLoading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading files...")
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground))
                } else if let errorMessage = viewModel.errorMessage {
                    HStack(spacing: 12) {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)

                        Spacer(minLength: 0)

                        Button("Try Again") {
                            Task { await retryLastLoad() }
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground))
                }
            }
        }
    }

    private var pathHeader: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(viewModel.breadcrumbs.enumerated()), id: \.element.id) { index, breadcrumb in
                    if index > 0 {
                        Image(systemName: "chevron.forward")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                    Button {
                        Task { await load(path: breadcrumb.path) }
                    } label: {
                        Text(breadcrumb.title)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    .disabled(breadcrumb.path == viewModel.currentPath)
                    .accessibilityLabel("Open \(breadcrumb.title)")
                }
            }
            .frame(height: 30)
            .padding(.horizontal, 16)
        }
        .frame(height: 30)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private var visibleEntries: [WorkspaceEntry] {
        let query = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return viewModel.entries }

        return viewModel.entries.filter { entry in
            entry.searchableText.localizedCaseInsensitiveContains(query)
        }
    }

    private func loadInitialRootIfNeeded() async {
        await viewModel.loadInitialRootIfNeeded(path: initialPath)
        handleLastError()
    }

    private func reloadCurrentPath() async {
        await viewModel.reloadCurrentPath()
        handleLastError()
    }

    private func retryLastLoad() async {
        await viewModel.retryLastLoad()
        handleLastError()
    }

    private func load(path: String) async {
        await viewModel.load(path: path)
        handleLastError()
    }

    private func handleLastError() {
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}


private extension WorkspaceEntry {
    var searchableText: String {
        [name, path, type]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

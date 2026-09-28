import SwiftUI
import TalariaKit

struct KanbanStatusFocusView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: KanbanFeatureState
    @State private var showsFilters = false
    @State private var showsBoardManagement = false
    @State private var visibleModel: KanbanFeatureState?
    @State private var cardEditor: KanbanCardEditorState?
    @State private var pendingRunningAction: KanbanPendingCardAction?
    @State private var showsBulkActions = false
    @State private var confirmsBulkArchive = false
    @State private var confirmsRunDispatcher = false
    @State private var showsDispatcher = false
    @State private var presentedCardID: String?
    @AccessibilityFocusState private var focusedCardID: String?
    @AccessibilityFocusState private var archiveUndoIsFocused: Bool
    @AccessibilityFocusState private var selectionControlsAreFocused: Bool
    @AccessibilityFocusState private var bulkSummaryIsFocused: Bool
    @AccessibilityFocusState private var dispatchSummaryIsFocused: Bool
    @AccessibilityFocusState private var dispatcherButtonIsFocused: Bool
    /// Width of the navigation content, which matches the navigation bar the toolbar fills.
    @State private var barWidth: CGFloat = 0
    /// One trailing control's width; it grows with Dynamic Type just as the controls do.
    @ScaledMetric(relativeTo: .body) private var toolbarControlWidth: CGFloat = 44

    private var toolbarLayout: KanbanBoardToolbarLayout {
        .resolve(containerWidth: barWidth, controlWidth: toolbarControlWidth)
    }

    var body: some View {
        Group {
            switch model.state {
            case .idle, .checking:
                loadingContent
            case .compatible, .partial:
                boardContent
            case .authenticationRequired:
                unavailableContent(
                    title: String(localized: "Sign in is required for Kanban."),
                    detail: String(localized: "Return to the server login screen, then try again."),
                    systemImage: "lock"
                )
            case .networkUnavailable:
                unavailableContent(
                    title: String(localized: "Kanban could not reach the server."),
                    detail: String(localized: "Check your connection, then try again."),
                    systemImage: "wifi.exclamationmark"
                )
            case .serverUnavailable:
                unavailableContent(
                    title: String(localized: "The Kanban server is unavailable."),
                    detail: String(localized: "Check that the Hermes server is awake, then try again."),
                    systemImage: "server.rack"
                )
            case .incompatibleContract:
                unavailableContent(
                    title: String(localized: "This server's Kanban response is incompatible with Talaria."),
                    detail: String(localized: "No Kanban changes were made."),
                    systemImage: "exclamationmark.triangle"
                )
            }
        }
        .navigationDestination(item: $presentedCardID) { cardID in
            KanbanCardDetailView(featureModel: model, cardID: cardID)
        }
        .navigationTitle(String(localized: "Kanban"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.searchText, prompt: Text("Search Cards"))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
        .toolbar { toolbarContent }
        .sheet(isPresented: $showsFilters) {
            KanbanFiltersView(model: model)
        }
        .sheet(isPresented: $showsDispatcher, onDismiss: {
            dispatcherButtonIsFocused = true
        }) {
            dispatcherSheet
        }
        .sheet(isPresented: $showsBoardManagement) {
            NavigationStack {
                KanbanBoardManagementView(model: model)
            }
        }
        .sheet(item: $cardEditor) { editor in
            KanbanCardEditorView(
                state: editor,
                allowsMutation: editor.isEditing ? model.canEditCards : model.canCreateCards,
                onSaved: { await model.reconcileAfterCardMutation() }
            )
        }
        .sheet(isPresented: $showsBulkActions, onDismiss: {
            selectionControlsAreFocused = true
        }) {
            KanbanBulkActionsView(
                model: model,
                onArchive: {
                    showsBulkActions = false
                    confirmsBulkArchive = true
                },
                onFinished: {
                    showsBulkActions = false
                    bulkSummaryIsFocused = true
                }
            )
        }
        .onAppear { activateCurrentModel() }
        .onDisappear {
            visibleModel?.setVisible(false)
            visibleModel = nil
        }
        .onChange(of: ObjectIdentifier(model)) { _, _ in
            activateCurrentModel()
            updateSceneActivity(scenePhase)
        }
        .onChange(of: scenePhase) { _, phase in
            updateSceneActivity(phase)
        }
        .onChange(of: model.isRefreshing) { wasRefreshing, isRefreshing in
            if wasRefreshing, !isRefreshing, model.isSelectingCards {
                selectionControlsAreFocused = true
            }
        }
        .onChange(of: model.dispatchState?.phase) { oldPhase, newPhase in
            if oldPhase?.isInFlight == true, newPhase?.isInFlight == false {
                if showsDispatcher {
                    dispatchSummaryIsFocused = true
                } else {
                    dispatcherButtonIsFocused = true
                }
            }
        }
        .onChange(of: presentedCardID) { previousCardID, currentCardID in
            guard currentCardID == nil, let previousCardID else { return }
            Task { @MainActor in
                await Task.yield()
                focusedCardID = KanbanCardRowPrimaryAction.focusTarget(
                    afterDismissing: previousCardID,
                    visibleCards: model.visibleCards
                )
            }
        }
        .alert(
            "Leave Running?",
            isPresented: Binding(
                get: { pendingRunningAction != nil },
                set: { if !$0 { pendingRunningAction = nil } }
            ),
            presenting: pendingRunningAction
        ) { pending in
            Button("Cancel", role: .cancel) { pendingRunningAction = nil }
            Button("Continue", role: .destructive) {
                pendingRunningAction = nil
                perform(pending.action, for: pending.card, confirmingRunningExit: true)
            }
        } message: { _ in
            Text("Leaving Running may clear the Card's claim and worker state.")
        }
        .alert("Archive Cards", isPresented: $confirmsBulkArchive) {
            Button("Cancel", role: .cancel) {
                selectionControlsAreFocused = true
            }
            Button("Archive Cards", role: .destructive) {
                Task {
                    await model.performBulkAction(.archiveCards)
                    bulkSummaryIsFocused = true
                }
            }
        } message: {
            Text("The selected Cards will be moved to the archive.")
        }
    }

    private func activateCurrentModel() {
        guard visibleModel !== model else {
            model.setVisible(true)
            return
        }
        visibleModel?.setVisible(false)
        visibleModel = model
        model.setVisible(true)
    }

    private func updateSceneActivity(_ phase: ScenePhase) {
        let isActive = phase == .active
        Task { await model.setSceneActive(isActive) }
    }

    private var loadingContent: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading Kanban")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Loading Kanban"))
    }

    private var boardContent: some View {
        VStack(spacing: 0) {
            if model.state == .partial {
                compatibilityBanner
            }
            if model.isOffline {
                offlineBanner
            } else if model.liveUpdatesDelayed {
                liveUpdatesDelayedBanner
            }
            if model.refreshFailed {
                refreshErrorBanner
            }
            if model.hasAvailableArchiveUndo, let undo = model.archiveUndo {
                archiveUndoBanner(undo)
            }
            if model.bulkActionPhase != nil {
                bulkProgressBanner
            } else if let summary = model.bulkActionSummary {
                bulkSummaryBanner(summary)
            }
            if model.requiresBoardSelection {
                boardSelectionContent
            } else {
                if model.isSelectingCards {
                    selectionControls
                }
                statusSelector
                Divider()
                cardList
            }
        }
    }

    private var dispatcherSheet: some View {
        NavigationStack {
            ScrollView {
                dispatcherPanel
                    .padding()
            }
            .navigationTitle("Dispatcher")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showsDispatcher = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .alert("Run Dispatcher", isPresented: $confirmsRunDispatcher) {
            Button("Cancel", role: .cancel) {}
            Button("Run Dispatcher", role: .destructive) {
                Task { await model.runDispatcher() }
            }
        } message: {
            Text(KanbanDispatchCopy.runConfirmation)
        }
    }

    private var dispatcherPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    previewDispatchButton
                    runDispatcherButton
                }
                VStack(spacing: 8) {
                    previewDispatchButton
                        .frame(maxWidth: .infinity)
                    runDispatcherButton
                        .frame(maxWidth: .infinity)
                }
            }

            Text("Preview is advisory and may become stale. It never starts workers.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let dispatcherUnavailableReason,
               model.dispatchState?.phase.isInFlight != true {
                Text(dispatcherUnavailableReason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let dispatch = model.dispatchState {
                Divider()
                dispatchSummary(dispatch)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var previewDispatchButton: some View {
        Button("Preview Dispatch") {
            Task { await model.previewDispatch() }
        }
        .buttonStyle(.bordered)
        .disabled(model.dispatcherAvailability != .available)
        .frame(minHeight: 44)
    }

    private var runDispatcherButton: some View {
        Button("Run Dispatcher") {
            confirmsRunDispatcher = true
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.dispatcherAvailability != .available)
        .frame(minHeight: 44)
    }

    @ViewBuilder
    private func dispatchSummary(_ dispatch: KanbanDispatchState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(dispatchModeTitle(dispatch.mode))
                    .font(.subheadline.weight(.semibold))
                if let completedAt = dispatch.completedAt {
                    Text(completedAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if !dispatch.phase.isInFlight, dispatch.phase != .outcomeUncertain {
                    Button("Dismiss") { model.dismissDispatchResult() }
                        .font(.footnote)
                }
            }

            if dispatch.phase.isInFlight {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(String(localized: dispatch.phase.statusTitle))
                }
                .font(.footnote)
            } else {
                Label {
                    Text(String(localized: dispatch.phase.statusTitle))
                } icon: {
                    Image(systemName: dispatchStatusIcon(dispatch))
                }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(dispatchStatusColor(dispatch))
            }

            if model.isPreviewStale {
                Label("This Preview is stale. Run Preview Dispatch again before relying on it.", systemImage: "clock.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if let result = dispatch.result {
                dispatchMetrics(result)
            }

            if dispatch.phase == .outcomeUncertain {
                Text("Talaria refreshed the Board, but cannot prove whether workers started. Review the current Board before running Dispatcher again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if dispatch.canAcknowledgeUncertainOutcome {
                    Button("I Reviewed the Board") {
                        model.dismissDispatchResult()
                    }
                    .font(.footnote.weight(.semibold))
                    .frame(minHeight: 44)
                }
                Button("Refresh") {
                    Task { await model.refreshUncertainDispatchOutcome() }
                }
                .font(.footnote.weight(.semibold))
                .frame(minHeight: 44)
            } else if dispatch.phase == .refused {
                Text("The server refused this Dispatcher request. Talaria did not retry it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if dispatch.phase == .boardUnavailable {
                Text("This Board no longer exists. Choose another Board.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            Text(KanbanDispatchAccessibility.summary(dispatch, isStale: model.isPreviewStale))
        )
        .accessibilityFocused($dispatchSummaryIsFocused)
    }

    private func dispatchMetrics(_ result: KanbanDispatchResult) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 5) {
            dispatchMetricRow("Spawned", result.spawned, "Promoted", result.promoted)
            dispatchMetricRow("Reclaimed", result.reclaimed, "Skipped—No Assignee", result.skippedUnassigned)
            dispatchMetricRow("Skipped—Unknown Profile", result.skippedNonspawnable, "Auto-blocked", result.autoBlocked)
            dispatchMetricRow("Timed Out", result.timedOut, "Crashed", result.crashed)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
    }

    private func dispatchMetricRow(
        _ firstLabel: LocalizedStringKey,
        _ firstCount: Int?,
        _ secondLabel: LocalizedStringKey,
        _ secondCount: Int?
    ) -> some View {
        GridRow {
            dispatchMetric(firstLabel, firstCount)
            dispatchMetric(secondLabel, secondCount)
        }
    }

    private func dispatchMetric(_ label: LocalizedStringKey, _ count: Int?) -> some View {
        HStack(spacing: 4) {
            Text(label)
            Text(count.map(String.init) ?? String(localized: "Unknown"))
                .fontWeight(.semibold)
        }
    }

    private var dispatcherUnavailableReason: LocalizedStringKey? {
        switch model.dispatcherAvailability {
        case .available: nil
        case .busy: "Another Board action is in progress."
        case .outcomeUncertain: "Outcome Uncertain"
        case .offline: "Offline—showing previously loaded data"
        case .incompatible: "Dispatcher is unavailable on this server."
        case .readOnly: "Read-only"
        case .refreshing: "The Board is refreshing."
        case .refreshFailed: "Refresh failed. Try again before using Dispatcher."
        }
    }

    private func dispatchModeTitle(_ mode: KanbanDispatchMode) -> LocalizedStringKey {
        switch mode {
        case .preview: "Preview Dispatch"
        case .run: "Run Dispatcher"
        }
    }

    private func dispatchStatusIcon(_ dispatch: KanbanDispatchState) -> String {
        switch dispatch.phase {
        case .succeeded: model.isPreviewStale ? "clock.badge.exclamationmark" : "checkmark.circle.fill"
        case .submitting, .reconciling: "arrow.triangle.2.circlepath"
        case .refused, .failed: "xmark.circle.fill"
        case .outcomeUncertain, .boardUnavailable: "questionmark.circle.fill"
        }
    }

    private func dispatchStatusColor(_ dispatch: KanbanDispatchState) -> Color {
        switch dispatch.phase {
        case .succeeded: model.isPreviewStale ? .orange : .green
        case .submitting, .reconciling: .secondary
        case .refused, .failed: .red
        case .outcomeUncertain, .boardUnavailable: .orange
        }
    }

    private var boardSelectionContent: some View {
        ContentUnavailableView {
            Label(
                model.boardSelectionNotice?.boardName ?? String(localized: "Board"),
                systemImage: "rectangle.stack.badge.minus"
            )
        } description: {
            Text("This Board no longer exists. Choose another Board.")
        } actions: {
            Menu("Choose Board") {
                ForEach(model.boards, id: \.slug) { board in
                    if let slug = board.slug {
                        Button(board.name ?? slug) {
                            Task { await model.selectBoard(slug) }
                        }
                    }
                }
            }
            .frame(minHeight: 44)
        }
    }

    private var bulkProgressBanner: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(model.bulkActionPhase == .submitting ? "Updating task..." : "Checking Result")
                .font(.footnote)
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.secondary.opacity(0.1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            Text(model.bulkActionPhase == .submitting ? "Updating task..." : "Checking Result")
        )
    }

    private func bulkSummaryBanner(_ summary: KanbanBulkActionSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(
                    summary.needsAttention.isEmpty ? "Complete" : "Needs Attention",
                    systemImage: summary.needsAttention.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .font(.footnote.weight(.semibold))
                Spacer()
                Button("Dismiss") { model.dismissBulkActionSummary() }
                    .font(.footnote)
            }
            HStack(spacing: 12) {
                Label {
                    HStack(spacing: 3) {
                        Text(verbatim: "\(summary.succeededCount)")
                        Text("Complete")
                    }
                } icon: {
                    Image(systemName: "checkmark.circle")
                }
                Label {
                    HStack(spacing: 3) {
                        Text(verbatim: "\(summary.failedCount)")
                        Text("Failed")
                    }
                } icon: {
                    Image(systemName: "xmark.circle")
                }
                Label {
                    HStack(spacing: 3) {
                        Text(verbatim: "\(summary.uncertainCount)")
                        Text("Outcome Uncertain")
                    }
                } icon: {
                    Image(systemName: "questionmark.circle")
                }
            }
            .font(.footnote)
            if !summary.needsAttention.isEmpty {
                ForEach(summary.needsAttention) { member in
                    Label {
                        HStack(spacing: 4) {
                            Text(member.cardTitle)
                            Text(member.outcome == .failed ? "Failed" : "Outcome Uncertain")
                        }
                    } icon: {
                        Image(systemName: member.outcome == .failed ? "xmark.circle" : "questionmark.circle")
                    }
                    .font(.footnote)
                }
            }
            if model.canRetryFailedBulkAction {
                Button("Retry Failed") {
                    Task {
                        await model.retryFailedBulkAction()
                        bulkSummaryIsFocused = true
                    }
                }
                .font(.footnote.weight(.semibold))
                .frame(minHeight: 44)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(summary.needsAttention.isEmpty ? Color.green.opacity(0.1) : Color.orange.opacity(0.12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(KanbanBulkAccessibility.resultLabel(summary))
        .accessibilityFocused($bulkSummaryIsFocused)
    }

    private var selectionControls: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(KanbanCountFormatter.cards(model.selectedCardCount))
                    .font(.subheadline.weight(.semibold))
                    .accessibilityLabel(
                        Text(KanbanCountFormatter.cards(model.selectedCardCount))
                        + Text(", ")
                        + Text("Selected")
                    )
                Spacer()
                Button("Bulk Actions") { showsBulkActions = true }
                    .disabled(model.bulkActionsAvailability != .available)
                    .fontWeight(.semibold)
                    .frame(minHeight: 44)
                Button("Done") {
                    model.clearCardSelection()
                }
                .frame(minHeight: 44)
            }
            if let explanation = bulkDisabledExplanation {
                Text(explanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(.secondary.opacity(0.08))
        .accessibilityElement(children: .contain)
        .accessibilityFocused($selectionControlsAreFocused)
    }

    private var bulkDisabledExplanation: String? {
        switch model.bulkActionsAvailability {
        case .available: nil
        case .noSelection: nil
        case .offline: String(localized: "Offline—showing previously loaded data")
        case .incompatible: String(localized: "Unavailable")
        case .readOnly: String(localized: "Read-only")
        case .refreshing: String(localized: "The Board is refreshing.")
        case .boardBusy: String(localized: "Updating task...")
        case .invalidSelection: String(localized: "The selection is no longer available. Refresh the Board and select the Cards again.")
        case .unknownStatus: String(localized: "Unknown Status")
        }
    }

    private func archiveUndoBanner(_ undo: KanbanArchiveUndo) -> some View {
        let recoveryPhase = model.mutationState(for: undo.cardID)?.phase
        let statusText = recoveryPhase == .outcomeUncertain
            ? String(localized: "Outcome Uncertain")
            : recoveryPhase == .failed
                ? String(localized: "Update failed")
                : String(localized: "Archived")
        let hasRecoveryError = recoveryPhase == .outcomeUncertain || recoveryPhase == .failed
        return HStack {
            Label(
                statusText,
                systemImage: hasRecoveryError ? "exclamationmark.circle" : "archivebox"
            )
                .lineLimit(2)
            Spacer()
            if recoveryPhase == .outcomeUncertain {
                Button("Refresh") {
                    Task { await model.checkUncertainMutation(for: undo.card) }
                }
                .fontWeight(.semibold)
            } else {
                Button(recoveryPhase == .failed ? "Try Again" : "Undo") {
                    Task { await model.undoArchive() }
                }
                .fontWeight(.semibold)
            }
        }
        .font(.footnote)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.secondary.opacity(0.1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            Text(
                String.localizedStringWithFormat(
                    String(localized: "%@, %@"),
                    undo.cardTitle,
                    statusText
                )
            )
        )
        .accessibilityFocused($archiveUndoIsFocused)
    }

    private var offlineBanner: some View {
        Label("Offline—showing previously loaded data", systemImage: "wifi.slash")
            .font(.footnote)
            .foregroundStyle(.orange)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.12))
            .accessibilityLabel(Text("Offline—showing previously loaded data"))
    }

    private var liveUpdatesDelayedBanner: some View {
        Label("Live updates delayed", systemImage: "arrow.clockwise.circle")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.secondary.opacity(0.08))
            .accessibilityLabel(Text("Live updates delayed"))
    }

    private var compatibilityBanner: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Kanban is available with limited capabilities.")
                if !model.unavailableWriteCapabilities.isEmpty {
                    Text("Unavailable")
                        + Text(verbatim: ": ")
                        + Text(verbatim: unavailableWriteCapabilityNames)
                }
            }
            .font(.footnote)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .foregroundStyle(.orange)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12))
    }

    private var unavailableWriteCapabilityNames: String {
        KanbanWriteCapability.allCases
            .filter(model.unavailableWriteCapabilities.contains)
            .map(\.title)
            .joined(separator: ", ")
    }

    private var refreshErrorBanner: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label("Could not refresh this Board. Previously loaded Cards remain visible.", systemImage: "exclamationmark.triangle")
                .font(.footnote)
            Spacer(minLength: 4)
            Button("Try Again") { Task { await model.refresh() } }
                .font(.footnote.weight(.semibold))
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.red.opacity(0.1))
    }

    private var statusSelector: some View {
        KanbanStatusSelector(model: model)
    }

    private struct KanbanStatusSelector: UIViewRepresentable {
        @Bindable var model: KanbanFeatureState
        @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 56

        func makeCoordinator() -> Coordinator {
            Coordinator(parent: self)
        }

        func makeUIView(context: Context) -> UIScrollView {
            let scrollView = KanbanStatusScrollView()
            scrollView.alwaysBounceHorizontal = false
            scrollView.alwaysBounceVertical = false
            scrollView.delaysContentTouches = false
            scrollView.isDirectionalLockEnabled = true
            scrollView.showsHorizontalScrollIndicator = false
            scrollView.showsVerticalScrollIndicator = false
            scrollView.refreshControl = nil
            scrollView.accessibilityIdentifier = "KanbanStatusSelector"
            context.coordinator.install(in: scrollView)
            return scrollView
        }

        func updateUIView(_ scrollView: UIScrollView, context: Context) {
            context.coordinator.parent = self
            context.coordinator.update(height: height)
        }

        @MainActor
        final class KanbanStatusScrollView: UIScrollView {
            override func touchesShouldCancel(in view: UIView) -> Bool {
                true
            }
        }

        func sizeThatFits(
            _ proposal: ProposedViewSize,
            uiView: UIScrollView,
            context: Context
        ) -> CGSize? {
            CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width, height: height)
        }

        @MainActor
        final class Coordinator: NSObject {
            var parent: KanbanStatusSelector
            private let stackView = UIStackView()
            private var controls: [String: KanbanStatusControl] = [:]
            private var orderedStatuses: [String] = []

            init(parent: KanbanStatusSelector) {
                self.parent = parent
            }

            func install(in scrollView: UIScrollView) {
                stackView.axis = .horizontal
                stackView.alignment = .center
                stackView.spacing = 8
                stackView.translatesAutoresizingMaskIntoConstraints = false
                scrollView.addSubview(stackView)
                let tapRecognizer = UITapGestureRecognizer(
                    target: self,
                    action: #selector(selectStatus(at:))
                )
                tapRecognizer.cancelsTouchesInView = false
                scrollView.addGestureRecognizer(tapRecognizer)

                NSLayoutConstraint.activate([
                    stackView.leadingAnchor.constraint(
                        equalTo: scrollView.contentLayoutGuide.leadingAnchor,
                        constant: 16
                    ),
                    stackView.trailingAnchor.constraint(
                        equalTo: scrollView.contentLayoutGuide.trailingAnchor,
                        constant: -16
                    ),
                    stackView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
                    stackView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
                    stackView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor)
                ])
            }

            func update(height: CGFloat) {
                let statuses = parent.model.availableStatuses
                if statuses != orderedStatuses {
                    rebuild(statuses)
                }

                let controlHeight = max(44, height - 12)
                for status in statuses {
                    let presentation = KanbanStatusPresentation(status)
                    controls[status]?.update(
                        title: presentation.title,
                        count: parent.model.statusCount(status),
                        color: UIColor(presentation.color),
                        isSelected: parent.model.selectedStatus == status,
                        height: controlHeight
                    )
                }
            }

            private func rebuild(_ statuses: [String]) {
                orderedStatuses = statuses
                for view in stackView.arrangedSubviews {
                    stackView.removeArrangedSubview(view)
                    view.removeFromSuperview()
                }
                controls.removeAll()

                for status in statuses {
                    let control = KanbanStatusControl()
                    control.status = status
                    control.addTarget(
                        self,
                        action: #selector(selectStatus(_:)),
                        for: [.touchUpInside, .primaryActionTriggered]
                    )
                    stackView.addArrangedSubview(control)
                    controls[status] = control
                }
            }

            @objc
            private func selectStatus(_ sender: KanbanStatusControl) {
                parent.model.selectedStatus = sender.status
            }

            @objc
            private func selectStatus(at recognizer: UITapGestureRecognizer) {
                guard recognizer.state == .ended else { return }
                let location = recognizer.location(in: stackView)
                guard let control = stackView.arrangedSubviews
                    .compactMap({ $0 as? KanbanStatusControl })
                    .first(where: { $0.frame.contains(location) })
                else { return }
                parent.model.selectedStatus = control.status
            }
        }

        @MainActor
        final class KanbanStatusControl: UIControl {
            var status = ""
            private let dotView = UIView()
            private let titleLabel = UILabel()
            private let countLabel = UILabel()
            private let stackView = UIStackView()
            private var heightConstraint: NSLayoutConstraint?

            override init(frame: CGRect) {
                super.init(frame: frame)
                isAccessibilityElement = true
                layer.cornerCurve = .continuous

                dotView.translatesAutoresizingMaskIntoConstraints = false
                dotView.layer.cornerRadius = 4
                NSLayoutConstraint.activate([
                    dotView.widthAnchor.constraint(equalToConstant: 8),
                    dotView.heightAnchor.constraint(equalToConstant: 8)
                ])

                titleLabel.adjustsFontForContentSizeCategory = true
                titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
                countLabel.adjustsFontForContentSizeCategory = true
                countLabel.font = .monospacedDigitSystemFont(
                    ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize,
                    weight: .regular
                )
                countLabel.textColor = .secondaryLabel

                stackView.axis = .horizontal
                stackView.alignment = .center
                stackView.spacing = 6
                stackView.translatesAutoresizingMaskIntoConstraints = false
                stackView.addArrangedSubview(dotView)
                stackView.addArrangedSubview(titleLabel)
                stackView.addArrangedSubview(countLabel)
                addSubview(stackView)

                NSLayoutConstraint.activate([
                    stackView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                    stackView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                    stackView.centerYAnchor.constraint(equalTo: centerYAnchor)
                ])
            }

            @available(*, unavailable)
            required init?(coder: NSCoder) {
                fatalError("init(coder:) has not been implemented")
            }

            func update(
                title: String,
                count: Int,
                color: UIColor,
                isSelected: Bool,
                height: CGFloat
            ) {
                titleLabel.text = title
                let preferredTitleFont = UIFont.preferredFont(forTextStyle: .subheadline)
                titleLabel.font = .systemFont(
                    ofSize: preferredTitleFont.pointSize,
                    weight: isSelected ? .semibold : .regular
                )
                countLabel.font = .monospacedDigitSystemFont(
                    ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize,
                    weight: .regular
                )
                countLabel.text = "\(count)"
                dotView.backgroundColor = color
                self.isSelected = isSelected
                backgroundColor = isSelected ? .secondarySystemFill : .clear
                layer.cornerRadius = height / 2
                accessibilityLabel = String.localizedStringWithFormat(
                    String(localized: "%@, %@"),
                    title,
                    KanbanCountFormatter.cards(count)
                )
                accessibilityTraits = isSelected ? [.button, .selected] : .button

                if heightConstraint?.constant != height {
                    heightConstraint?.isActive = false
                    heightConstraint = heightAnchor.constraint(equalToConstant: height)
                    heightConstraint?.isActive = true
                }
            }
        }
    }

    private var cardList: some View {
        List {
            if model.isRefreshing {
                HStack {
                    Spacer()
                    ProgressView("Refreshing Board")
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }

            if model.isRefreshing, model.snapshot == nil {
                EmptyView()
            } else if model.visibleCards.isEmpty {
                emptyContent
                    .listRowSeparator(.hidden)
            } else if model.groupByProfile {
                ForEach(Array(model.groupedVisibleCards.enumerated()), id: \.offset) { _, group in
                    Section {
                        ForEach(group.cards, id: \.cardID) { card in
                            cardNavigationLink(card)
                        }
                    } header: {
                        Text(group.profile ?? String(localized: "Unassigned"))
                    }
                }
            } else {
                ForEach(model.visibleCards, id: \.cardID) { card in
                    cardNavigationLink(card)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await model.refresh() }
    }

    @ViewBuilder
    private func cardNavigationLink(_ card: KanbanCard) -> some View {
        if model.isSelectingCards {
            Button {
                activateCard(card)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: model.selectedCardIDs.contains(card.cardID ?? "")
                          ? "checkmark.circle.fill"
                          : "circle")
                        .font(.title3)
                    KanbanCardSummaryView(card: card)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .accessibilityLabel(
                KanbanBulkAccessibility.selectionLabel(
                    card,
                    isSelected: model.selectedCardIDs.contains(card.cardID ?? "")
                )
            )
            .accessibilityAddTraits(
                model.selectedCardIDs.contains(card.cardID ?? "")
                    ? .isSelected
                    : AccessibilityTraits()
            )
        } else {
            ZStack(alignment: .trailing) {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        activateCard(card)
                    } label: {
                        KanbanCardSummaryView(card: card, reservesTrailingActionSpace: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .disabled(card.cardID == nil)
                    .accessibilityLabel(KanbanCardAccessibility.summary(card))
                    .accessibilityFocused($focusedCardID, equals: card.cardID)

                    mutationStatus(for: card)
                }

                cardActionsMenu(card)
            }
        }
    }

    private func activateCard(_ card: KanbanCard) {
        switch KanbanCardRowPrimaryAction.resolve(for: card, isSelecting: model.isSelectingCards) {
        case let .openDetail(cardID):
            focusedCardID = cardID
            presentedCardID = cardID
        case .toggleSelection:
            model.toggleCardSelection(card)
            selectionControlsAreFocused = true
        case nil:
            break
        }
    }

    private func cardActionsMenu(_ card: KanbanCard) -> some View {
        Menu {
            let destinations = model.moveDestinations(for: card)
            if !destinations.isEmpty {
                Menu("Move") {
                    ForEach(destinations, id: \.self) { destination in
                        Button(KanbanStatusPresentation(destination).title) {
                            request(.move(destination), for: card)
                        }
                    }
                }
            }
            if card.status?.rawValue == "blocked" {
                Button("Unblock") { request(.unblock, for: card) }
            } else if card.status?.rawValue != "archived" {
                Button("Block") { request(.block, for: card) }
            }
            if card.status?.rawValue != "done", card.status?.rawValue != "archived" {
                Button("Complete") { request(.complete, for: card) }
            }
            if card.status?.rawValue != "archived" {
                Button("Archive", role: .destructive) { request(.archive, for: card) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(.primary)
                .frame(minWidth: 44, minHeight: 44)
        }
        .tint(.primary)
        .disabled(!model.canMutateCard(card) || model.isMutatingCard(card.cardID))
        .accessibilityLabel(Text("Card Actions"))
    }

    @ViewBuilder
    private func mutationStatus(for card: KanbanCard) -> some View {
        if let mutation = model.mutationState(for: card.cardID) {
            switch mutation.phase {
            case .updating:
                Label("Updating task...", systemImage: "arrow.triangle.2.circlepath")
                    .font(.footnote).foregroundStyle(.secondary)
            case .checkingResult:
                Label("Checking Result", systemImage: "arrow.triangle.2.circlepath")
                    .font(.footnote).foregroundStyle(.secondary)
            case .succeeded:
                Label("Updated", systemImage: "checkmark.circle.fill")
                    .font(.footnote).foregroundStyle(.green)
            case .failed:
                HStack {
                    Label("Update failed", systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                    Button("Try Again") { retryMutation(for: card) }
                }
                .font(.footnote)
            case .outcomeUncertain:
                HStack {
                    Label("Outcome Uncertain", systemImage: "questionmark.circle")
                        .foregroundStyle(.orange)
                    Button("Refresh") { Task { await model.checkUncertainMutation(for: card) } }
                }
                .font(.footnote)
            }
        }
    }

    private func request(_ action: KanbanCardAction, for card: KanbanCard) {
        if card.status?.rawValue == "running" {
            pendingRunningAction = KanbanPendingCardAction(card: card, action: action)
        } else {
            perform(action, for: card)
        }
    }

    private func perform(
        _ action: KanbanCardAction,
        for card: KanbanCard,
        confirmingRunningExit: Bool = false
    ) {
        Task {
            switch action {
            case let .move(status):
                await model.moveCard(card, to: status, confirmingRunningExit: confirmingRunningExit)
                if model.mutationState(for: card.cardID)?.phase == .succeeded {
                    model.selectedStatus = status
                    await Task.yield()
                    focusedCardID = card.cardID
                }
            case .block:
                await model.blockCard(card, reason: nil, confirmingRunningExit: confirmingRunningExit)
                if model.mutationState(for: card.cardID)?.phase == .succeeded {
                    model.selectedStatus = "blocked"
                    await Task.yield()
                    focusedCardID = card.cardID
                }
            case .unblock:
                await model.unblockCard(card)
                if model.mutationState(for: card.cardID)?.phase == .succeeded {
                    model.selectedStatus = "ready"
                    await Task.yield()
                    focusedCardID = card.cardID
                }
            case .complete:
                await model.completeCard(card, confirmingRunningExit: confirmingRunningExit)
                if model.mutationState(for: card.cardID)?.phase == .succeeded {
                    model.selectedStatus = "done"
                    await Task.yield()
                    focusedCardID = card.cardID
                }
            case .archive:
                await model.archiveCard(card, confirmingRunningExit: confirmingRunningExit)
                if model.hasAvailableArchiveUndo {
                    archiveUndoIsFocused = true
                }
            }
        }
    }

    private func retryMutation(for card: KanbanCard) {
        guard card.status?.rawValue == "running",
              let mutation = model.mutationState(for: card.cardID) else {
            Task { await model.retryMutation(for: card) }
            return
        }
        switch mutation.kind {
        case let .status(status): request(status == "done" ? .complete : .move(status), for: card)
        case .block: request(.block, for: card)
        case .archive: request(.archive, for: card)
        default: Task { await model.retryMutation(for: card) }
        }
    }

    private var emptyContent: some View {
        ContentUnavailableView {
            Label(
                model.hasActiveFilters ? String(localized: "No matching Cards") : String(localized: "No Cards in this Status"),
                systemImage: model.hasActiveFilters ? "line.3.horizontal.decrease.circle" : "rectangle.stack"
            )
        } description: {
            Text(model.hasActiveFilters
                 ? String(localized: "Change or clear the filters to see more Cards.")
                 : String(localized: "Choose another Status or refresh the Board."))
        } actions: {
            if model.hasActiveFilters {
                Button("Clear Filters") { Task { await model.clearFilters() } }
                    .frame(minHeight: 44)
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Menu {
                ForEach(model.boards, id: \.slug) { board in
                    if let slug = board.slug {
                        Button {
                            Task { await model.selectBoard(slug) }
                        } label: {
                            if slug == model.selectedBoardSlug {
                                Label(board.name ?? slug, systemImage: "checkmark")
                            } else {
                                Text(board.name ?? slug)
                            }
                        }
                    }
                }
                Divider()
                Button {
                    showsBoardManagement = true
                } label: {
                    Label("Manage", systemImage: "slider.horizontal.3")
                }
            } label: {
                HStack(spacing: 4) {
                    Text(model.selectedBoard?.name ?? model.selectedBoardSlug ?? String(localized: "Board"))
                        .lineLimit(1)
                        .frame(maxWidth: toolbarLayout.boardNameWidth, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                }
                .frame(minHeight: 44)
            }
            .accessibilityLabel(String(localized: "Switch Board"))
            .accessibilityIdentifier("KanbanBoardPicker")
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            if !toolbarLayout.usesOverflowMenu {
                selectCardsButton
            }

            Button {
                cardEditor = model.makeCreateCardEditorState()
            } label: {
                Image(systemName: "plus")
            }
            .disabled(!model.canCreateCards)
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityLabel(Text("New Card"))

            Button {
                showsDispatcher = true
            } label: {
                Label(
                    "Dispatcher",
                    systemImage: KanbanDispatcherPresentation.toolbarSystemImage(
                        for: model.dispatchState
                    )
                )
            }
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityLabel(
                Text(KanbanDispatcherPresentation.toolbarAccessibilityLabel(for: model.dispatchState))
            )
            .accessibilityFocused($dispatcherButtonIsFocused)

            if toolbarLayout.usesOverflowMenu {
                overflowMenu
            } else {
                filtersButton
            }
        }
    }

    private var selectCardsButton: some View {
        Button(action: toggleCardSelection) {
            Image(systemName: model.isSelectingCards ? "xmark" : "checkmark.circle")
        }
        .disabled(!canToggleCardSelection)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(model.isSelectingCards ? Text("Cancel") : Text("Select Cards"))
    }

    private var filtersButton: some View {
        Button {
            showsFilters = true
        } label: {
            Image(systemName: filtersSystemImage)
        }
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(Text("Card Filters"))
    }

    /// Holds Select Cards and Card Filters when the bar is too narrow for four trailing
    /// controls. The button keeps reporting active filters so the indication is not lost.
    private var overflowMenu: some View {
        Menu {
            Button(action: toggleCardSelection) {
                Label(
                    model.isSelectingCards ? String(localized: "Cancel") : String(localized: "Select Cards"),
                    systemImage: model.isSelectingCards ? "xmark" : "checkmark.circle"
                )
            }
            .disabled(!canToggleCardSelection)

            Button {
                showsFilters = true
            } label: {
                Label(String(localized: "Card Filters"), systemImage: filtersSystemImage)
            }
        } label: {
            Image(systemName: model.hasActiveFilters ? "ellipsis.circle.fill" : "ellipsis.circle")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(model.hasActiveFilters ? Text("More, filters active") : Text("More"))
        .accessibilityIdentifier("KanbanToolbarOverflow")
    }

    private var filtersSystemImage: String {
        model.hasActiveFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"
    }

    private var canToggleCardSelection: Bool {
        model.bulkActionPhase == nil && model.canUseBulkActions
    }

    private func toggleCardSelection() {
        if model.isSelectingCards {
            model.clearCardSelection()
        } else {
            model.beginSelectingCards()
            selectionControlsAreFocused = true
        }
    }

    private func unavailableContent(title: String, detail: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(detail)
        } actions: {
            Button("Try Again") { Task { await model.retry() } }
                .frame(minHeight: 44)
        }
    }
}

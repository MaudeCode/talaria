import SwiftUI
import TalariaKit

struct ToolCallCardView: View {
    let toolCall: ToolCall
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @Environment(\.chatFullToolResultLoader) private var loadFullToolResult
    @Environment(\.chatScreenReads) private var screenReads
    @Environment(\.chatProcessOutputTails) private var processOutputTails
    @AppStorage(ChatTranscriptDisplaySettings.toolCardsStartExpandedKey) private var startsExpanded = false
    @ChatRetainedState("tool-expansion") private var userToggledExpansion: Bool? = nil
    /// TAL-331: the whole result of a call the server clipped or capped, once the reader asked for it.
    @ChatRetainedState("tool-result") private var fullResult: ToolResultResponse? = nil
    @ChatRetainedState("tool-result-loading") private var isLoadingFullResult = false
    @ChatRetainedState("tool-result-failure") private var fullResultFailed = false
    /// TAL-2338: the reader's choice of the open row's raw view; nil until they choose, so the row opens as the server says
    /// (TAL-2341 `opens_raw`, else formatted).
    @ChatRetainedState("tool-raw") private var showsRaw: Bool? = nil
    @State private var copyConfirmation = ChatCodeBlock.CopyConfirmation()

    init(toolCall: ToolCall) {
        self.toolCall = toolCall
        _userToggledExpansion = ChatRetainedState(wrappedValue: nil, "tool:\(toolCall.id):expanded")
        _fullResult = ChatRetainedState(wrappedValue: nil, "tool:\(toolCall.id):result")
        _isLoadingFullResult = ChatRetainedState(wrappedValue: false, "tool:\(toolCall.id):loading")
        _fullResultFailed = ChatRetainedState(wrappedValue: false, "tool:\(toolCall.id):failure")
        _showsRaw = ChatRetainedState(wrappedValue: nil, "tool:\(toolCall.id):raw")
    }

    private var isExpanded: Bool {
        ChatTranscriptDisplaySettings.isCardExpanded(
            userToggled: userToggledExpansion,
            startsExpanded: startsExpanded
        )
    }

    var body: some View {
        let statusDisplay = ToolCallStatusDisplay(toolCall: toolCall)

        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                chatDisclosureToggled()
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                    userToggledExpansion = !isExpanded
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Self.accessibilityText(for: toolCall, detail: statusDisplay.accessibilityDetailText))
            .accessibilityHint(isExpanded ? "Double tap to collapse details." : "Double tap to expand details.")

            // TAL-2340: the latest output line of the background process the call started, while it runs.
            if let processID = toolCall.processID, let tail = processOutputTails[processID] {
                Text(verbatim: tail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 24)
                    .padding(.bottom, 4)
                    .forcedLeftToRight()
            }

            // TAL-2333: a delegation's subagents stay in view under its counts.
            if let agents = toolCall.background?.agentsDetail, !agents.isEmpty {
                DelegateAgentRows(agents: agents)
            }

            // TAL-1965: a decision review stays in view whether or not the call's details are open.
            if let reference = toolCall.resultView?.decisionReview {
                DecisionReviewResultSection(reference: reference)
            }

            // TAL-1967: so does a proposal, with its Approve and Reject.
            if let reference = toolCall.resultView?.proposal {
                ProposalResultSection(reference: reference)
            }

            // TAL-1968: and a block the agent showed.
            if let reference = toolCall.resultView?.block {
                ShowBlockResultSection(reference: reference)
            }

            // TAL-1997: and a terminal the agent opened, which Open follows read-only.
            if let reference = toolCall.resultView?.terminal {
                TerminalResultSection(reference: reference)
            }

            // TAL-2325: and the images, speech or video a media tool made. TAL-2341: only inside the open row when the
            // server says so (`media_in_details`).
            if let media = toolCall.resultView?.media, !media.isEmpty, isExpanded || !toolCall.displayFlags.mediaInDetails {
                ToolResultMediaSection(media: media)
                    .padding(.top, 6)
            }

            if isExpanded {
                expandedContent(statusDisplay: statusDisplay)
                    .padding(.leading, 24)
                    .forcedLeftToRight()
                    .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum ToolsHost { case arguments, result, alone }

    /// TAL-2338: the server sent a raw view to switch to; an older server sends none.
    private var hasRaw: Bool { toolCall.rawArgs != nil || toolCall.rawResult != nil }
    private var isRaw: Bool { (showsRaw ?? toolCall.displayFlags.opensRaw) && hasRaw }
    /// A clipped result's raw view is the whole one, once fetched; the clipped text never shows as raw.
    private var rawResult: String? { toolCall.resultTruncated ? fullResult?.rawResult : toolCall.rawResult }

    private func expandedContent(statusDisplay: ToolCallStatusDisplay) -> some View {
        var shownCall = toolCall
        if let fullResult {
            shownCall.resultView = fullResult.view
        }
        let displayContent = ToolCallDisplayFormatter.content(for: shownCall)
        let copyText = isRaw
            ? [toolCall.rawArgs, rawResult].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            : ToolCallDisplayFormatter.copyText(for: shownCall)
        let tools = AnyView(rowTools(copyText: copyText, copyBlocked: isRaw && toolCall.resultTruncated && rawResult == nil))
        // The tools ride on the first section's label, or stand alone above a first section without one.
        let host: ToolsHost = isRaw
            ? (toolCall.rawArgs != nil ? .arguments : rawResult != nil ? .result : .alone)
            : (toolCall.editDiff == nil && !displayContent.argumentRows.isEmpty ? .arguments : .alone)

        return VStack(alignment: .leading, spacing: 7) {
            if host == .alone {
                HStack { Spacer(minLength: 0); tools }
            }
            if isRaw {
                if let rawArgs = toolCall.rawArgs {
                    rawSection(String(localized: "Arguments"), text: rawArgs, tools: tools)
                }
                if let rawResult {
                    rawSection(String(localized: "Result"), text: rawResult, tools: host == .result ? tools : nil)
                } else if toolCall.rawResult != nil, toolCall.resultTruncated, loadFullToolResult != nil {
                    fullResultButton
                }
            } else if let editDiff = toolCall.editDiff {
                // TAL-448: a file edit shows its change; its arguments and result restate the same diff.
                editDiffSection(editDiff)
            } else {
                if !displayContent.argumentRows.isEmpty {
                    argumentsSection(displayContent.argumentRows, tools: tools)
                }

                // TAL-2323: a read's lines and a search's matches, in place of their text.
                if let excerpt = shownCall.resultView?.fileExcerpt {
                    FileExcerptSection(excerpt: excerpt)
                    // TAL-2328: code a call ran (an excerpt without a path) shows its output under it.
                    if excerpt.path.isEmpty, let result = displayContent.result {
                        resultSection(result)
                    }
                } else if let matches = shownCall.resultView?.matches {
                    SearchMatchesSection(matches: matches)
                } else if let links = shownCall.resultView?.links {
                    // TAL-2324: a search's links and an extract's pages likewise.
                    ResultLinksSection(links: links)
                } else if let pages = shownCall.resultView?.pages {
                    ResultPagesSection(pages: pages)
                } else if let analysis = shownCall.resultView?.analysis {
                    // TAL-2325: an image or video analysis, formatted.
                    ToolAnalysisSection(analysis: analysis)
                } else if let rows = shownCall.resultView?.rows {
                    // TAL-2326: memory, skill, past-chat, job, connection and clarify results as rows.
                    ToolRowsSection(rows: rows)
                } else if let result = displayContent.result {
                    resultSection(result)
                }
            }

            if !isRaw, toolCall.resultTruncated, fullResult == nil, loadFullToolResult != nil {
                fullResultButton
            }

            if shouldShowStatusDetail(displayContent: displayContent) {
                statusDetail(statusDisplay.detailText)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            ToolActivityIcon(name: statusIcon, logoURL: toolCall.isError == true ? nil : toolCall.app?.logoURL)
                .foregroundStyle(statusColor)
                .frame(width: 16, height: 16)

            VStack(alignment: .leading, spacing: 2) {
                titleLine
                if let progress = ToolCallStatusDisplay(toolCall: toolCall).progressText {
                    Text(progress)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            // TAL-2335: the title line measures against the whole row, so an outcome's 55% is of the row, not a split share.
            .layoutPriority(1)

            // TAL-448: a file edit's added and removed line counts, beside its label.
            if let editDiff = toolCall.editDiff {
                DiffCountsLabel(additions: editDiff.added, deletions: editDiff.removed)
                    .fixedSize()
            }

            Spacer(minLength: 6)

            // TAL-372: a delegation row shows its subagents' progress, updated in place as they finish.
            if let background = toolCall.background {
                Text(Self.backgroundSummary(background))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            // TAL-2340: a running call's time so far, from the server's start; it leaves when the call ends.
            if ToolCallStatusDisplay.runningElapsed(for: toolCall, now: .now) != nil {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(ToolCallStatusDisplay.runningElapsed(for: toolCall, now: context.date) ?? "")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize()
                        .accessibilityHidden(true)
                }
            }

            if hasExpandableContent {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// The row's spoken label: what the call did, its status, a file edit's counts, and a delegation's progress.
    static func accessibilityText(for toolCall: ToolCall, detail: String) -> String {
        var label = String(localized: "\(AssistantActivitySummary.label(for: toolCall)), \(detail)")
        if let progress = ToolCallStatusDisplay(toolCall: toolCall).progressText { label += ", \(progress)" }
        if let outcome = Self.outcomeText(for: toolCall) { label += ", \(outcome)" }
        if let editDiff = toolCall.editDiff {
            label += ", \(String(localized: "\(editDiff.added) added")), \(String(localized: "\(editDiff.removed) removed"))"
        }
        guard let background = toolCall.background else { return label }
        return "\(label), \(Self.backgroundSummary(background))"
    }

    static func backgroundSummary(_ link: BackgroundLink) -> String {
        let counts = BackgroundWorkSheet.agentsSummary(link.agents)
        switch link.status {
        case .running, .completed: return counts
        default: return "\(BackgroundWorkSheet.statusLabel(link.status)) · \(counts)"
        }
    }

    /// TAL-2335: the label, then what the finished call did past a middle dot, in the tone the server gave it.
    @ViewBuilder private var titleLine: some View {
        if let outcome = Self.outcomeText(for: toolCall) {
            ToolOutcomeLineLayout {
                titleText
                HStack(spacing: 6) {
                    Text(verbatim: "·").foregroundStyle(.secondary)
                    Text(outcome).foregroundStyle(Self.outcomeStyle(toolCall.resultView?.outcome?.tone))
                }
                .padding(.leading, 6)
                .font(AppFont.callout())
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityHidden(true)
            }
        } else {
            titleText
        }
    }

    /// TAL-2335: a finished call's outcome in the reader's words; nil while it runs or when the server gave none.
    static func outcomeText(for toolCall: ToolCall) -> String? {
        guard toolCall.isCompleted, let outcome = toolCall.resultView?.outcome else { return nil }
        return outcome.text
    }

    /// TAL-2335: routine outcomes stay in the label's secondary tier; colour marks only a failure or a wait on the user.
    static func outcomeStyle(_ tone: ToolOutcome.Tone?) -> AnyShapeStyle {
        switch tone {
        case .error: AnyShapeStyle(Color.red)
        case .attention: AnyShapeStyle(Color.orange)
        case .neutral, nil: AnyShapeStyle(.secondary)
        }
    }

    private var titleText: some View {
        ActivityGlowText(
            text: AssistantActivitySummary.label(for: toolCall),
            isActive: !toolCall.isCompleted && toolCall.isError != true
        )
            .font(AppFont.callout())
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var statusIcon: String {
        if toolCall.isError == true {
            return "exclamationmark.triangle.fill"
        }

        return AssistantActivitySummary.icon(for: toolCall)
    }

    private var statusColor: Color {
        if toolCall.isError == true {
            return .red
        }

        return .secondary
    }

    private var hasExpandableContent: Bool {
        let content = ToolCallDisplayFormatter.content(for: toolCall)
        return toolCall.editDiff != nil || !content.argumentRows.isEmpty || content.result != nil || shouldShowStatusDetail(displayContent: content)
    }

    private func shouldShowStatusDetail(displayContent: ToolCallDisplayContent) -> Bool {
        let hasPrimaryContent = toolCall.editDiff != nil || !displayContent.argumentRows.isEmpty || displayContent.result != nil
        return !hasPrimaryContent || !toolCall.isCompleted || toolCall.isError == true || toolCall.duration != nil
    }

    private func statusDetail(_ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Status")
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            Text(value)
                .font(AppFont.caption())
                .foregroundStyle(statusColor)
                .textSelection(.enabled)
        }
    }

    /// TAL-2338: `{}` switches the open row between its formatted and raw views; Copy copies whichever shows.
    private func rowTools(copyText: String, copyBlocked: Bool) -> some View {
        HStack(spacing: 0) {
            if hasRaw {
                Button {
                    chatDisclosureToggled()
                    showsRaw = !isRaw
                    // The checkmark confirmed the other view's copy.
                    copyConfirmation.reset()
                    if isRaw, toolCall.resultTruncated, fullResult == nil {
                        startFullResult()
                    }
                } label: {
                    Image(systemName: "curlybraces")
                        .frame(width: 32, height: 32)
                        .background(isRaw ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 6))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(isRaw ? String(localized: "Show formatted") : String(localized: "Show raw"))
                .accessibilityAddTraits(isRaw ? .isSelected : [])
                .help(isRaw ? String(localized: "Show formatted") : String(localized: "Show raw"))
            }
            Button {
                PlatformHooks.copyText(copyText)
                copyConfirmation.copied(at: .now)
            } label: {
                Image(systemName: copyConfirmation.isShowing ? "checkmark" : "doc.on.doc")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .contentTransition(.symbolEffect(.replace))
            }
            .disabled(copyText.isEmpty || copyBlocked)
            .accessibilityLabel(copyConfirmation.isShowing ? String(localized: "Copied") : isRaw ? String(localized: "Copy raw") : String(localized: "Copy"))
            .help(isRaw ? String(localized: "Copy raw") : String(localized: "Copy"))
        }
        .buttonStyle(.borderless)
        .font(AppFont.caption(weight: .semibold))
        .foregroundStyle(.secondary)
        .task(id: copyConfirmation.expiresAt) {
            guard let expiresAt = copyConfirmation.expiresAt else { return }
            try? await Task.sleep(until: expiresAt, clock: .continuous)
            guard !Task.isCancelled else { return }
            copyConfirmation.expire(at: .now)
        }
    }

    /// A section's label, carrying the row's tools at its end when it is the first section.
    private func sectionLabel(_ title: String, tools: AnyView?) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Text(title)
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if let tools { tools }
        }
    }

    /// TAL-2338: the server's raw arguments or result, monospaced and selectable.
    private func rawSection(_ title: String, text: String, tools: AnyView?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            sectionLabel(title, tools: tools)
            Text(text)
                .font(AppFont.mono(style: .caption))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(7)
                .chatTimelineAccessoryInsetSurface()
        }
    }

    private func argumentsSection(_ rows: [ToolCallArgumentDisplay], tools: AnyView) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel(String(localized: "Arguments"), tools: tools)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(rows) { row in
                    argumentRow(row)
                }
            }
            .padding(7)
            .chatTimelineAccessoryInsetSurface()
        }
    }

    private var fullResultButton: some View {
        Button {
            startFullResult()
        } label: {
            Text(isLoadingFullResult ? String(localized: "Loading…") : fullResultFailed ? String(localized: "Retry") : String(localized: "Show full output"))
                .font(AppFont.caption(weight: .semibold))
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(isLoadingFullResult)
    }

    /// The fetch is the chat screen's read (`ScreenReads`), so leaving the chat cancels it; outside a chat screen it runs alone.
    private func startFullResult() {
        guard let screenReads else {
            Task { await showFullResult() }
            return
        }
        screenReads.start("tool-result:\(toolCall.id)") { await showFullResult() }
    }

    private func showFullResult() async {
        guard let loadFullToolResult, !isLoadingFullResult else { return }
        isLoadingFullResult = true
        defer { isLoadingFullResult = false }
        do {
            let result = try await loadFullToolResult(toolCall.id)()
            guard !Task.isCancelled else { return }
            chatDisclosureToggled()
            fullResultFailed = false
            fullResult = result
        } catch {
            // A cancelled read (the reader left the chat) is neither a result nor a failure.
            guard !Task.isCancelled, !APIError.isCancellation(error) else { return }
            fullResultFailed = true
        }
    }

    private func resultSection(_ result: ToolCallResultDisplay) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(result.title)
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            if result.rows.isEmpty {
                Text(result.text)
                    .font(result.isMonospaced ? AppFont.mono(style: .caption) : AppFont.caption())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(7)
                    .chatTimelineAccessoryInsetSurface()
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(result.rows) { row in
                        argumentRow(row)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(7)
                .chatTimelineAccessoryInsetSurface()
            }
        }
    }

    /// The diff in the workspace diff view's rows, each hunk under its line label; long lines wrap.
    private func editDiffSection(_ editDiff: ToolEditDiff) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Changes")
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)
            EditDiffHunks(editDiff: editDiff)
        }
    }

    @ViewBuilder
    private func argumentRow(_ row: ToolCallArgumentDisplay) -> some View {
        ToolArgumentRow(row: row)
    }
}

/// One key/value row of a call's arguments or JSON result; an approval card (TAL-2333) shows the held call's the same way.
struct ToolArgumentRow: View {
    let row: ToolCallArgumentDisplay
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                key
                value
            }
        } else {
            HStack(alignment: .top, spacing: 7) {
                key
                    .frame(width: 78, alignment: .leading)

                value
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var key: some View {
        Text(row.key)
            .font(AppFont.mono(style: .caption2, weight: .semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }

    private var value: some View {
        Text(row.value)
            .font(AppFont.mono(style: .caption))
            .foregroundStyle(.primary)
            .textSelection(.enabled)
    }
}

/// TAL-2333: a delegation's subagents under its row: status, goal, seconds once finished and its summary's first line.
/// Each opens its unit in the chat's Background tasks sheet.
struct DelegateAgentRows: View {
    let agents: [BackgroundLink.Agent]
    @Environment(\.chatOpenBackgroundTask) private var openBackgroundTask

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
                Button {
                    openBackgroundTask?(agent.taskId)
                } label: {
                    row(agent)
                }
                .buttonStyle(.plain)
                .disabled(openBackgroundTask == nil)
                .accessibilityElement(children: .combine)
                .accessibilityHint(String(localized: "Show in Background tasks"))
                .accessibilityIdentifier("delegate-agent-\(agent.taskId)")
                .contextMenu {
                    if openBackgroundTask != nil {
                        Button(String(localized: "Show in Background tasks"), systemImage: "list.bullet") { openBackgroundTask?(agent.taskId) }
                    }
                    Button(String(localized: "Copy"), systemImage: "doc.on.doc") { PlatformHooks.copyText(agent.goal) }
                }
            }
        }
        .padding(.leading, 24)
    }

    private func row(_ agent: BackgroundLink.Agent) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: BackgroundWorkSheet.icon(agent.status))
                .font(.caption.weight(.semibold))
                .foregroundStyle(BackgroundWorkSheet.tint(agent.status))
                .accessibilityLabel(BackgroundWorkSheet.statusLabel(agent.status))
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.goal)
                    .font(AppFont.caption())
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let summary = agent.summary {
                    Text(summary)
                        .font(AppFont.caption2())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if let duration = agent.duration {
                Text(ChatActiveRunStatusPresentation.elapsedText(seconds: duration, showSeconds: true))
                    .font(AppFont.caption2())
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(ChatActiveRunStatusPresentation.accessibilityElapsedText(seconds: duration))
            }
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
    }
}

/// TAL-2333: shows one delegation unit in the chat's Background tasks sheet; the chat screen supplies it.
typealias ChatOpenBackgroundTask = ChatEnvironmentAction<String, Void>

struct ChatOpenBackgroundTaskKey: EnvironmentKey {
    static var defaultValue: ChatOpenBackgroundTask? { nil }
}

extension EnvironmentValues {
    var chatOpenBackgroundTask: ChatOpenBackgroundTask? {
        get { self[ChatOpenBackgroundTaskKey.self] }
        set { self[ChatOpenBackgroundTaskKey.self] = newValue }
    }
}

/// TAL-331: fetches the whole result of a tool call the server clipped; the chat screen supplies it for its session.
typealias ChatFullToolResultLoader = ChatEnvironmentAction<String, @MainActor () async throws -> ToolResultResponse>

extension EnvironmentValues {
    /// TAL-2338: the chat screen's button-started reads, which a tool row's whole-result fetch runs under.
    @Entry var chatScreenReads: ScreenReads? = nil
    /// TAL-2340: each running background process's latest output line by its process id, from the chat's Background Work.
    @Entry var chatProcessOutputTails: [String: String] = [:]
}

struct ChatFullToolResultLoaderKey: EnvironmentKey {
    static var defaultValue: ChatFullToolResultLoader? { nil }
}

extension EnvironmentValues {
    var chatFullToolResultLoader: ChatFullToolResultLoader? {
        get { self[ChatFullToolResultLoaderKey.self] }
        set { self[ChatFullToolResultLoaderKey.self] = newValue }
    }
}

/// TAL-1967: a change the agent proposed, as the server shows it: summary and status, the diff or field list, the risk
/// notes, the outcome, and Approve and Reject for the server owner. The decision shows at once and rolls back when the
/// server refuses it; the session's `proposal` events reread the rest.
struct ProposalResultSection: View {
    let reference: ProposalRef
    @Environment(\.chatProposalModel) private var makeModel
    @State private var model: ProposalCardModel?

    var body: some View {
        let proposal = model?.proposal
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(proposal?.summary ?? reference.summary)
                    .font(AppFont.callout(weight: .semibold))
                Spacer(minLength: 6)
                if let proposal {
                    Text(Self.statusLabel(proposal.status))
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            if let proposal, let model {
                details(proposal)
                if let error = model.lastError {
                    Text(error.localizedDescription)
                        .font(AppFont.caption())
                        .foregroundStyle(.red)
                }
                if proposal.actions.canApprove || proposal.actions.canReject {
                    HStack(spacing: 12) { decisionButtons(proposal, model) }
                        .frame(minHeight: 44)
                }
            }
        }
        .contextMenu {
            if let proposal, let model { decisionButtons(proposal, model) }
        }
        .padding(.leading, 24)
        .task(id: reference.proposalId) {
            if model == nil { model = makeModel?(reference.proposalId) }
            await model?.load()
        }
        .onReceive(NotificationCenter.default.publisher(for: .talariaProposalChanged)) { notification in
            guard (notification.object as? ProposalEvent)?.proposalId == reference.proposalId else { return }
            Task { await model?.load() }
        }
    }

    /// The decisions the server permits, as the card's buttons and as its context menu's items (a menu ignores the styles).
    @ViewBuilder
    private func decisionButtons(_ proposal: Proposal, _ model: ProposalCardModel) -> some View {
        if proposal.actions.canApprove {
            Button(String(localized: "Approve")) { Task { await model.approve() } }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("proposal-approve-\(reference.proposalId)")
        }
        if proposal.actions.canReject {
            Button(String(localized: "Reject")) { Task { await model.reject() } }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("proposal-reject-\(reference.proposalId)")
        }
    }

    @ViewBuilder
    private func details(_ proposal: Proposal) -> some View {
        if !proposal.diff.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(proposal.diff) { DiffLineRow(line: $0) }
            }
            .textSelection(.enabled)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .forcedLeftToRight()
        }
        ForEach(Array(proposal.fields.enumerated()), id: \.offset) { _, field in
            VStack(alignment: .leading, spacing: 1) {
                Text(field.label)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                Text(field.value)
                    .font(AppFont.callout())
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
        }
        ForEach(Array(proposal.riskNotes.enumerated()), id: \.offset) { _, note in
            Text(note)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
        if let text = proposal.outcome.error ?? proposal.outcome.text {
            Text(text)
                .font(AppFont.caption())
                .foregroundStyle(proposal.outcome.error == nil ? Color.green : Color.red)
        }
    }

    static func statusLabel(_ status: Proposal.Status) -> String {
        switch status {
        case .pending: String(localized: "Waiting for approval")
        case .approved: String(localized: "Approved")
        case .rejected: String(localized: "Rejected")
        case .applied: String(localized: "Applied")
        case .failed: String(localized: "Failed")
        case .expired: String(localized: "Expired")
        }
    }
}

/// TAL-1967: the card model for a proposal id; the chat screen supplies it with its session's client.
typealias ChatProposalModel = ChatEnvironmentAction<String, ProposalCardModel>

private struct ChatProposalModelKey: EnvironmentKey {
    static var defaultValue: ChatProposalModel? { nil }
}

extension EnvironmentValues {
    var chatProposalModel: ChatProposalModel? {
        get { self[ChatProposalModelKey.self] }
        set { self[ChatProposalModelKey.self] = newValue }
    }
}

/// A tool row's icon at the shared 14 pt glyph size: an SF Symbol, or (TAL-2317) the Talaria mark for Talaria's own tools.
/// TAL-2330: a connector call's catalog logo, rounded, in place of the symbol once it loads; the symbol while it loads or fails.
struct ToolActivityIcon: View {
    let name: String
    var logoURL: URL?

    var body: some View {
        if let logoURL {
            AsyncImage(url: logoURL) { phase in
                if let image = phase.image {
                    image
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .accessibilityHidden(true)
                } else {
                    symbol
                }
            }
        } else {
            symbol
        }
    }

    @ViewBuilder private var symbol: some View {
        if name == AssistantActivitySummary.talariaMarkIcon {
            Image(name)
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 14, height: 14)
                .accessibilityHidden(true)
        } else {
            Image(systemName: name)
                .font(.system(size: 14))
        }
    }
}

/// TAL-2335: a tool row's label and its outcome on one line. The outcome keeps its width up to 55% of the line and the
/// label takes the rest, so the label truncates first.
struct ToolOutcomeLineLayout: Layout {
    static let outcomeShare: CGFloat = 0.55

    /// The whole offered line, so placement splits the same width the measurement did; its ideal width when none is offered.
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let (label, outcome) = widths(proposal: proposal, subviews: subviews)
        let height = subviews.map { $0.sizeThatFits(ProposedViewSize(width: nil, height: proposal.height)).height }.max() ?? 0
        guard let line = proposal.width, line.isFinite else { return CGSize(width: label + outcome, height: height) }
        return CGSize(width: line, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (label, outcome) = widths(proposal: ProposedViewSize(width: bounds.width, height: bounds.height), subviews: subviews)
        var x = bounds.minX
        for (subview, width) in zip(subviews, [label, outcome]) {
            subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width
        }
    }

    private func widths(proposal: ProposedViewSize, subviews: Subviews) -> (CGFloat, CGFloat) {
        guard subviews.count == 2 else { return (0, 0) }
        let ideal = subviews.map { $0.sizeThatFits(.unspecified).width }
        return Self.widths(line: proposal.width, label: ideal[0], outcome: ideal[1])
    }

    /// The label's and the outcome's widths in a `line` this wide, from their ideal widths: each its ideal while both fit,
    /// else the outcome up to 55% of the line and the label what is left.
    static func widths(line: CGFloat?, label: CGFloat, outcome: CGFloat) -> (label: CGFloat, outcome: CGFloat) {
        guard let line, line.isFinite else { return (label, outcome) }
        let shown = min(outcome, line * outcomeShare)
        return (min(label, max(line - shown, 0)), shown)
    }
}

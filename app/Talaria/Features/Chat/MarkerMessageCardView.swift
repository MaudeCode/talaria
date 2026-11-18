import SwiftUI
import TalariaKit

/// A row the server marks as a compaction marker or preserved task list (TAL-305), in place of a message bubble: one flat
/// disclosure line on the `ReasoningBlockView` pattern, so it reads like the transcript's other activity rows (TAL-1566).
struct MarkerMessageCardView: View {
    let kind: ChatMarkerMessageKind?
    let content: String?
    let activity: TalariaActivity?
    let messageID: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @Environment(\.chatOpenDecisionReview) private var openReview
    @ChatRetainedState("marker-expansion") private var isExpanded = false

    /// `stateID` names the row, so its expansion follows it, not its kind or position.
    init(kind: ChatMarkerMessageKind, content: String?, stateID: String) {
        self.kind = kind
        self.content = content
        self.activity = nil
        self.messageID = nil
        _isExpanded = ChatRetainedState(wrappedValue: false, "marker-expansion:\(stateID)")
    }

    init(activity: TalariaActivity, stateID: String, messageID: String? = nil) {
        self.kind = nil
        self.content = activity.details
        self.activity = activity
        self.messageID = messageID
        _isExpanded = ChatRetainedState(wrappedValue: false, "marker-expansion:\(stateID)")
    }

    private var title: String { activity?.summary ?? kind?.title ?? "" }
    private var accessibilityTitle: String { activity == nil ? title : "Talaria. \(title)" }
    private var hasDetails: Bool { !(content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var reviewID: String? { activity?.target?.kind == "decision_review" && openReview != nil ? activity?.target?.id : nil }

    var body: some View {
        let body = (content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        VStack(alignment: .leading, spacing: isExpanded ? 6 : 0) {
            if hasDetails || reviewID != nil {
                Button {
                    if let reviewID { openReview?(reviewID); return }
                    chatDisclosureToggled()
                    withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) { isExpanded.toggle() }
                } label: { header }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibilityTitle)
                .accessibilityHint(body.isEmpty ? "" : isExpanded ? String(localized: "Double tap to collapse details.") : String(localized: "Double tap to expand details."))
                .accessibilityIdentifier(activity == nil ? "transcript-marker" : "transcript-activity")
            } else {
                header.accessibilityElement(children: .ignore).accessibilityLabel(accessibilityTitle)
            }
            PendingSteerButtonsView(messageID: messageID)

            if isExpanded && !body.isEmpty {
                Text(verbatim: body)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 24)
                    .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { PendingSteerButtonsView(messageID: messageID, inMenu: true) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if activity != nil {
                SandalMark(height: 16, color: .secondary)
            } else {
                Image(systemName: iconName).resizable().scaledToFit()
                    .foregroundStyle(.secondary).frame(width: 16, height: 16)
            }
            Text(verbatim: title).font(AppFont.callout())
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .truncationMode(.tail)
                .foregroundStyle(activity == nil ? Color.primary : Color.secondary)
            Spacer(minLength: 4)
            if hasDetails {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary).rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
        .frame(minHeight: 44).contentShape(Rectangle())
    }

    private var iconName: String {
        switch kind {
        case .contextCompaction:
            return "arrow.down.right.and.arrow.up.left"
        case .preservedTaskList:
            return "checklist"
        case nil:
            return "info.circle"
        }
    }
}

/// An automatic background wakeup (TAL-460): one quiet line per finished item, never the user's bubble. The Agent's
/// reply follows as an ordinary message; tapping the lines shows the full notification.
struct BackgroundUpdateLinesView: View {
    let update: BackgroundUpdate
    let message: ChatMessage

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @ChatRetainedState("background-expansion") private var isExpanded = false
    @ChatRetainedState("background-body") private var showsFullBody = false

    init(update: BackgroundUpdate, message: ChatMessage) {
        self.update = update
        self.message = message
        _isExpanded = ChatRetainedState(wrappedValue: false, "background:\(message.id):expanded")
        _showsFullBody = ChatRetainedState(wrappedValue: false, "background:\(message.id):body")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                chatDisclosureToggled()
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                summary
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summaryAccessibilityLabel)
            .accessibilityHint(isExpanded ? String(localized: "Double tap to collapse details.") : String(localized: "Double tap to expand details."))
            .accessibilityIdentifier("background-update-lines")

            if isExpanded {
                if message.talariaActivity != nil {
                    detail.padding(.leading, 24).transition(.opacity)
                } else {
                    detail.padding(.horizontal, 10).padding(.vertical, 9)
                        .accessorySurface(fallbackMaterial: .thinMaterial, cornerRadius: 10).transition(.opacity)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // The label and its spoken text are properties: inside the button's chain the type checker re-checked them
    // hundreds of times (TAL-2470).
    private var summary: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.talariaActivity != nil { SandalMark(height: 16, color: .secondary) }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(update.lines.enumerated()), id: \.offset) { _, line in
                    BackgroundLineRow(line: line, parentReview: update.reviewState)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
    }

    private var summaryAccessibilityLabel: String {
        let lines = update.lines.map { BackgroundLineRow.accessibilityText(for: $0, parentReview: update.reviewState) }
        return (message.talariaActivity == nil ? "" : "Talaria. ") + lines.joined(separator: ", ")
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: bodyText)
                .font(AppFont.caption())
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if message.displayExcerpt != nil {
                Button(showsFullBody ? String(localized: "Show less") : String(localized: "Show more")) {
                    showsFullBody.toggle()
                }
                .font(AppFont.caption())
                .buttonStyle(.borderless)
            }
        }
    }

    private var bodyText: String {
        if !showsFullBody, let excerpt = message.displayExcerpt { return excerpt }
        return message.content ?? ""
    }
}

private struct BackgroundLineRow: View {
    let line: BackgroundLine
    let parentReview: BackgroundReviewState?

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            if line.reviewStateForDisplay == .reviewing {
                ProgressView().controlSize(.mini)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: BackgroundWorkSheet.icon(line.reviewStateForDisplay))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(line.reviewStateForDisplay == .failed ? Color.orange : Color.secondary)
                    .accessibilityHidden(true)
            }
            Text(verbatim: line.label)
                .font(line.kind == .command ? AppFont.mono(style: .footnote) : AppFont.footnote())
                .foregroundStyle(line.kind == .agent ? Color.primary : Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .help(Self.accessibilityText(for: line, parentReview: parentReview))
    }

    static func reviewLabel(_ state: BackgroundReviewState?) -> String {
        switch state {
        case .waiting: String(localized: "Waiting for the parent to review this result.")
        case .reviewing: String(localized: "The parent is reviewing this result.")
        case .reviewed: String(localized: "The parent reviewed this result.")
        case .failed: String(localized: "The worker or parent review failed.")
        case .unknown, nil: String(localized: "The worker or parent review outcome is unknown.")
        }
    }

    static func accessibilityText(for line: BackgroundLine, parentReview: BackgroundReviewState?) -> String {
        var text = "\(line.label). \(reviewLabel(line.reviewStateForDisplay))"
        if let parentReview, parentReview != line.reviewStateForDisplay {
            let state = reviewLabel(parentReview)
            text += " " + String(localized: "Parent review: \(state)")
        }
        return text
    }
}

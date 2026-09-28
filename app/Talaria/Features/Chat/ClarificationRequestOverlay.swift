import SwiftUI
import TalariaKit

struct ClarificationRequestContent: View {
    let prompt: ClarificationPromptState
    let isResponding: Bool
    let errorMessage: String?
    let onSubmit: (String) -> Void
    var selectedChoices: [String] = []
    var onToggleChoice: (String) -> Void = { _ in }
    var onSelectQuestion: (Int) -> Void = { _ in }

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        cardContent
            .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 6) {
            if prompt.questionCount > 1 {
                Button {
                    onSelectQuestion(prompt.questionIndex - 1)
                } label: {
                    Image(systemName: "chevron.left")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isResponding || prompt.questionIndex == 0)
                .accessibilityLabel("Previous question")
            } else {
                Image(systemName: "questionmark.circle")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 3) {
                if prompt.questionCount > 1 {
                    Text("Question \(prompt.questionIndex + 1) of \(prompt.questionCount)")
                        .font(.subheadline.weight(.semibold))
                } else {
                    Text("Clarification Required")
                        .font(.headline)
                }

                if prompt.pendingCount > 1 {
                    Text("1 of \(prompt.pendingCount) pending")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if prompt.questionCount > 1 {
                Button {
                    onSelectQuestion(prompt.questionIndex + 1)
                } label: {
                    Image(systemName: "chevron.right")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isResponding || prompt.isLastQuestion)
                .accessibilityLabel("Next question")
            }

            Spacer(minLength: 0)
            expirationView
        }
    }

    private var question: some View {
        Text(prompt.question)
            .font(.subheadline)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var choicesList: some View {
        VStack(spacing: 8) {
            ForEach(prompt.choices, id: \.self) { choice in
                choiceButton(choice)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let errorMessage = nonEmpty(errorMessage) {
            Text(errorMessage)
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var expirationView: some View {
        if prompt.pending.expiresAt != nil || prompt.pending.timeoutSeconds != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                expirationBadge(now: context.date)
            }
        }
    }

    private func expirationBadge(now: Date) -> some View {
        let remaining = remainingSeconds(now: now)
        let fraction = remainingFraction(now: now)

        return VStack(alignment: .trailing, spacing: 5) {
            Text(expirationText(remaining: remaining))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(.primary.opacity(0.10))
                    Capsule()
                        .fill(progressFill)
                        .frame(width: max(0, proxy.size.width * fraction))
                }
            }
            .frame(width: 68, height: 4)
            .accessibilityLabel("Clarification expiration")
            .accessibilityValue(expirationText(remaining: remaining))
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    question
                    if !prompt.choices.isEmpty {
                        choicesList
                    }
                    footer
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
    }

    @ViewBuilder
    private func choiceButton(_ choice: String) -> some View {
        Button {
            if prompt.isMultiSelect { onToggleChoice(choice) } else { onSubmit(choice) }
        } label: {
            HStack {
                Text(choice)
                if prompt.isMultiSelect {
                    Spacer(minLength: 8)
                    Image(systemName: selectedChoices.contains(choice) ? "checkmark.circle.fill" : "circle")
                        .accessibilityHidden(true)
                }
            }
                .font(.callout.weight(.semibold))
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .foregroundStyle(.primary)
                .choiceButtonSurface(reduceTransparency: reduceTransparency)
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.chatTactile(.capsule))
        .disabled(isResponding)
        .accessibilityAddTraits(selectedChoices.contains(choice) ? .isSelected : [])
    }

    private var progressFill: Color {
        colorScheme == .dark ? Color.white.opacity(0.72) : Color.black.opacity(0.58)
    }

    private func remainingSeconds(now: Date) -> TimeInterval? {
        guard let expiresAt = prompt.pending.expiresAt else { return nil }
        return max(0, expiresAt - now.timeIntervalSince1970)
    }

    private func remainingFraction(now: Date) -> CGFloat {
        guard let remaining = remainingSeconds(now: now),
              let timeoutSeconds = prompt.pending.timeoutSeconds,
              timeoutSeconds > 0
        else {
            return 1
        }

        return CGFloat(min(1, max(0, remaining / Double(timeoutSeconds))))
    }

    private func expirationText(remaining: TimeInterval?) -> String {
        guard let remaining else {
            guard let timeoutSeconds = prompt.pending.timeoutSeconds else { return "" }
            return String(localized: "Timeout \(Self.durationText(Double(timeoutSeconds)))")
        }

        if remaining <= 0 {
            return String(localized: "Expired")
        }

        return String(localized: "\(Self.durationText(remaining)) left")
    }

    private static func durationText(_ seconds: TimeInterval) -> String {
        let value = max(0, Int(seconds.rounded(.up)))
        let minutes = value / 60
        let seconds = value % 60

        guard minutes > 0 else {
            return "\(seconds)s"
        }

        return "\(minutes)m \(seconds)s"
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

private extension View {
    @ViewBuilder
    func choiceButtonSurface(reduceTransparency: Bool) -> some View {
        if reduceTransparency {
            background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
        } else if #available(iOS 26.0, *) {
            // Fixed corner radius (not .capsule): a capsule's radius grows with the
            // button's height, so on tall multi-line options the curved ends bow
            // inward and clip the text. A fixed radius keeps the outline clear of
            // the label at any line count and matches the fallbacks below.
            glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))
        } else {
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(.primary.opacity(0.10), lineWidth: 1)
                )
        }
    }
}

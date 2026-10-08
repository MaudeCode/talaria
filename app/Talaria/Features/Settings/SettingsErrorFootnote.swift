import SwiftUI
import TalariaKit

struct SettingsErrorFootnote: View {
    let error: SettingsErrorText

    init(_ error: SettingsErrorText) {
        self.error = error
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(AppFont.caption())
                .foregroundStyle(.orange)

            Text(error.message)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .copyableError(error)
    }
}

extension View {
    /// Tapping the error opens a menu whose one Copy action writes the shown
    /// message and its technical detail, so it can be pasted into a report.
    func copyableError(_ error: SettingsErrorText?) -> some View {
        modifier(CopyableErrorModifier(error: error))
    }
}

private struct CopyableErrorModifier: ViewModifier {
    let error: SettingsErrorText?

    func body(content: Content) -> some View {
        if let error {
            Menu {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = error.copiedText
                }
            } label: {
                content.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(String(localized: "Opens a menu to copy the error."))
        } else {
            content
        }
    }
}

import SwiftUI
import TalariaKit

struct GitActionToastOverlay: View {
    let state: GitActionToastState
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if let success = state.success {
                toast(
                    title: success.title,
                    subtitle: success.subtitle,
                    detailLines: success.detailLines,
                    isDismissable: true,
                    action: success.action
                ) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white, .green)
                        .symbolRenderingMode(.palette)
                }
                .id(success.id)
            } else if let progress = state.progress {
                toast(
                    title: progress.title,
                    subtitle: progress.subtitle,
                    detailLines: progress.detailLines,
                    isDismissable: false
                ) {
                    ProgressView().controlSize(.regular)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func toast<Icon: View>(
        title: String,
        subtitle: String?,
        detailLines: [String],
        isDismissable: Bool,
        action: GitActionSuccess.Action? = nil,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            icon().frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 3) {
                if let action {
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                    layout {
                        Text(title).font(AppFont.subheadline(weight: .semibold))
                        Button(action: action.perform) {
                            Text(action.title)
                                .underline()
                                .font(AppFont.subheadline(weight: .semibold))
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("git-action-toast-action")
                    }
                } else {
                    Text(title).font(AppFont.subheadline(weight: .semibold))
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(AppFont.caption()).foregroundStyle(.secondary)
                }
                ForEach(detailLines, id: \.self) { line in
                    Text(line).font(AppFont.caption()).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isDismissable {
                Button(action: state.dismissSuccess) {
                    Image(systemName: "xmark").font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(14)
        .adaptiveGlass(in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
    }
}

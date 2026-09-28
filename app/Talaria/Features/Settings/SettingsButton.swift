import SwiftUI
import TalariaKit

struct SettingsButton: View {
    let title: String
    var role: ButtonRole?
    var isLoading = false
    let action: () -> Void

    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    init(_ title: String, role: ButtonRole? = nil, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

        Button(role: role, action: action) {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    Text(title)
                }
            }
            .font(AppFont.subheadline(weight: .medium))
            .foregroundStyle(role == .destructive ? .red : .primary)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 46)
            .background {
                shape.fill((role == .destructive ? Color.red : Color.primary).opacity(0.08))
            }
            .adaptiveGlass(
                .regular,
                isInteractive: true,
                tint: role == .destructive ? .red.opacity(0.08) : nil,
                fallbackMaterial: .thinMaterial,
                in: shape
            )
            .overlay {
                shape
                    .stroke((role == .destructive ? Color.red : Color.primary).opacity(strokeOpacity), lineWidth: 0.7)
                    .allowsHitTesting(false)
            }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
    }

    private var strokeOpacity: Double {
        colorSchemeContrast == .increased ? 0.24 : 0.12
    }
}

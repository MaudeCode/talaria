import SwiftUI

/// A section title with a `?` at the trailing edge that opens a short
/// explanation, instead of prose under the section.
struct SettingsSectionHeader: View {
    let title: String
    let onHelp: () -> Void

    var body: some View {
        SidebarSectionHeader(title: title) {
            Button(action: onHelp) {
                Image(systemName: "questionmark.circle")
                    .font(.body)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .textCase(nil)
            .accessibilityLabel(String(localized: "About \(title)"))
        }
    }
}

struct SettingsSectionHelp: Identifiable {
    let id = UUID()
    let title: String
    let message: String

    static var identityMessage: String {
        String(localized: """
        Shown on this device. With iCloud Sync on, a server's name, initials and colour sync with that \
        server's saved details.
        """)
    }
}

extension View {
    /// Presents the tapped section's explanation as a plain alert.
    func settingsSectionHelp(_ help: Binding<SettingsSectionHelp?>) -> some View {
        alert(
            help.wrappedValue?.title ?? "",
            isPresented: Binding(
                get: { help.wrappedValue != nil },
                set: { if !$0 { help.wrappedValue = nil } }
            )
        ) {
            Button("OK") { help.wrappedValue = nil }
        } message: {
            Text(help.wrappedValue?.message ?? "")
        }
    }
}

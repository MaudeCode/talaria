import SwiftUI
import TalariaKit

struct AvatarServerSwitcherMenu: View {
    let model: AvatarServerSwitcherModel
    let switchToServer: (ServerAccount) -> Void
    let addServer: () -> Void
    let manageServers: () -> Void

    var body: some View {
        Section("Servers") {
            ForEach(model.entries) { entry in
                Button {
                    switchToServer(entry.account)
                } label: {
                    Label(entry.displayName, systemImage: entry.isActive ? "checkmark" : "server.rack")
                }
                .disabled(entry.isActive)
                .accessibilityLabel(
                    entry.isActive
                        ? String(localized: "\(entry.displayName), active server")
                        : String(localized: "Switch to \(entry.displayName)")
                )
            }
        }

        Section {
            Button {
                addServer()
            } label: {
                Label("Add Server…", systemImage: "plus")
            }

            Button {
                manageServers()
            } label: {
                Label("Manage Servers", systemImage: "gearshape")
            }
        }
    }
}

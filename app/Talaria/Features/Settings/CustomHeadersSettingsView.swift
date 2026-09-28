import SwiftUI
import TalariaKit

struct CustomHeadersSettingsView: View {
    @Bindable var authManager: AuthManager
    @State private var headers: [CustomHeader]
    @Environment(\.scenePhase) private var scenePhase

    init(authManager: AuthManager) {
        self.authManager = authManager
        _headers = State(initialValue: authManager.currentCustomHeaders)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                CustomHeadersEditor(headers: $headers)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Connection Headers")
        .navigationBarTitleDisplayMode(.inline)
        // Live-refresh the network clients on every edit (cheap, in-memory only)
        // but defer the slow Keychain write until the editor is dismissed so
        // typing never stutters.
        .onChange(of: headers) { _, newValue in
            authManager.updateCustomHeaders(newValue, persist: false)
        }
        .onDisappear {
            authManager.updateCustomHeaders(headers, persist: true)
        }
        // onDisappear doesn't fire when the app is backgrounded or terminated
        // mid-edit, so also flush to the Keychain when the scene leaves active.
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                authManager.updateCustomHeaders(headers, persist: true)
            }
        }
    }
}

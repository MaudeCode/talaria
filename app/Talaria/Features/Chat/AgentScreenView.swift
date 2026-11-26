import SwiftUI
import TalariaKit
import UIKit

extension EnvironmentValues {
    @Entry var chatOpenScreen: ChatEnvironmentAction<Void, Void>?
}

/// A sheet keeps the viewer's lifetime separate from the chat's transcript and composer.
struct AgentScreenView: View {
    @State private var viewer: ScreenSession
    @State private var attempt = 0
    @State private var showsKeyboard = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    init(client: APIClient, sessionID: String) {
        _viewer = State(initialValue: ScreenSession(client: client, sessionID: sessionID))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Screen")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Label("Close screen", systemImage: "xmark") }
                            .help("Close screen")
                    }
                    if viewer.frame != nil {
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            if viewer.canSendInput {
                                Button {
                                    showsKeyboard.toggle()
                                } label: {
                                    if showsKeyboard {
                                        Label("Hide Keyboard", systemImage: "keyboard.chevron.compact.down")
                                    } else {
                                        Label("Show keyboard", systemImage: "keyboard")
                                    }
                                }
                                .help(showsKeyboard ? Text("Hide Keyboard") : Text("Show keyboard"))
                            }
                            Button {
                                Task { await viewer.changeControl() }
                            } label: {
                                if viewer.control == .you {
                                    Label("Hand back", systemImage: "hand.raised.slash")
                                } else {
                                    Label("Take over", systemImage: "hand.raised")
                                }
                            }
                            .help(viewer.control == .you ? Text("Hand back") : Text("Take over"))
                            .disabled(!viewer.canChangeControl)
                            .accessibilityIdentifier("screen-control")
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if viewer.frame != nil {
                        VStack(spacing: 4) {
                            if let error = viewer.error {
                                Text(error.localizedDescription)
                                    .foregroundStyle(.red)
                            }
                            controlStatus
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(.background)
                    }
                }
        }
        .task(id: attempt) { await viewer.watch() }
        .onDisappear { Task { await viewer.close() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { dismiss() }
        }
        .onChange(of: viewer.canSendInput) { _, allowed in
            if !allowed { showsKeyboard = false }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let frame = viewer.frame {
            ScreenCanvas(viewer: viewer, image: frame, canSendInput: viewer.canSendInput, showsKeyboard: showsKeyboard)
                .accessibilityLabel("Agent desktop")
                .accessibilityIdentifier("screen-desktop")
        } else if viewer.isLoading {
            ProgressView("Connecting to screen…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let end = viewer.end {
            switch end {
            case .disconnected: status("Screen disconnected", icon: "display.trianglebadge.exclamationmark")
            case .controlTaken: status("Another viewer took control", icon: "hand.raised")
            case .desktopGone: status("Screen stopped", icon: "display")
            case .signedOut: status("Sign in to reconnect", icon: "lock", retry: false)
            }
        } else if viewer.screen?.state == .notInstalled {
            status("Screen is not installed", icon: "display", command: viewer.screen?.installCommand)
        } else if viewer.screen?.state == .stopped {
            status("Screen stopped", icon: "display")
        } else {
            status("Screen unavailable", icon: "display")
        }
    }

    @ViewBuilder
    private var controlStatus: some View {
        switch viewer.control {
        case .you: Text("You have control")
        case .other: Text("Another viewer has control")
        case .agent, nil: Text("Watching")
        }
    }

    private func status(_ title: LocalizedStringKey, icon: String, command: String? = nil, retry: Bool = true) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            if let command {
                Text(verbatim: command)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .forcedLeftToRight()
            }
        } actions: {
            HStack(spacing: 12) {
                if let command {
                    statusAction("Copy install command", symbol: "document.on.document") {
                        UIPasteboard.general.string = command
                    }
                }
                if retry {
                    statusAction("Refresh screen", symbol: "arrow.clockwise") { attempt += 1 }
                }
            }
        }
    }

    private func statusAction(_ title: LocalizedStringKey, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .labelStyle(.iconOnly)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .help(Text(title))
    }
}

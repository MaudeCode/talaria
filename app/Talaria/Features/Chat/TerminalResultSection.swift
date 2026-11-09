import SwiftUI
import TalariaKit

/// TAL-1997: the terminal a `terminal_open` started, under its transcript row: its title, the command the agent typed,
/// and Open, which pushes the read-only terminal view.
struct TerminalResultSection: View {
    let reference: TerminalRef
    @Environment(\.chatOpenTerminal) private var openTerminal

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(reference.title)
                .font(AppFont.callout(weight: .semibold))
            if let command = reference.command, command != reference.title {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let openTerminal {
                Button(String(localized: "Open")) { openTerminal(reference) }
                    .font(AppFont.callout(weight: .semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44, alignment: .leading)
                    .accessibilityLabel(String(localized: "Open terminal"))
                    .accessibilityIdentifier("terminal-open-\(reference.terminalId)")
            }
        }
        .contextMenu {
            if let openTerminal {
                Button(String(localized: "Open terminal")) { openTerminal(reference) }
            }
        }
        .padding(.leading, 24)
    }
}

/// TAL-1997: the agent's terminal, read-only: the server's text from the start, followed live until the shell exits. It
/// takes no input and offers no close. The newest line stays in view while the reader has not scrolled up.
struct TerminalOutputView: View {
    @State private var model: TerminalFollowModel
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var followsEnd = true

    init(model: TerminalFollowModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(model.lines.indices, id: \.self) { index in
                    // An empty line keeps its height.
                    Text(model.lines[index].isEmpty ? " " : model.lines[index])
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .accessibilityIdentifier("terminal-output")
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 24
        } action: { _, atEnd in
            followsEnd = atEnd
        }
        .onChange(of: model.lines) {
            if followsEnd { position.scrollTo(edge: .bottom) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { status }
        .background(Color(.systemBackground))
        .navigationTitle(model.reference.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.start() }
        .onDisappear { model.stop() }
    }

    private var status: some View {
        HStack(spacing: 8) {
            if model.running, !model.gone { ProgressView().controlSize(.small) }
            Text(statusText)
                .font(AppFont.caption())
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.systemBackground))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("terminal-status")
    }

    private var statusText: String {
        if model.gone { return String(localized: "This terminal is no longer available") }
        if model.running { return model.lastError == nil ? String(localized: "Running") : String(localized: "Reconnecting…") }
        guard let exitCode = model.exitCode else { return String(localized: "Exited") }
        return String(localized: "Exited with code \(exitCode)")
    }
}

/// TAL-1997: pushes the read-only view of a `terminal_open` card's terminal.
typealias ChatOpenTerminal = ChatEnvironmentAction<TerminalRef, Void>

private struct ChatOpenTerminalKey: EnvironmentKey {
    static var defaultValue: ChatOpenTerminal? { nil }
}

extension EnvironmentValues {
    var chatOpenTerminal: ChatOpenTerminal? {
        get { self[ChatOpenTerminalKey.self] }
        set { self[ChatOpenTerminalKey.self] = newValue }
    }
}

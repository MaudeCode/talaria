import SwiftUI
import TalariaKit

/// TAL-1321: the pending-input panel's body for a chat's connection operation. Every state, link and move comes from the
/// server's view; a typed credential lives only in this view until it is sent.
struct ConnectionOperationContent: View {
    let operation: ConnectorOperationView
    let runningTargets: Set<String>
    let errorMessage: String?
    let onMove: (ConnectorOperationMove, [String: String]?) -> Void
    let onDismiss: () -> Void

    @Environment(\.openURL) private var openURL
    @State private var values: [String: [String: String]] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(operation.targets) { target in
                        row(target)
                        if target.id != operation.targets.last?.id { Divider() }
                    }
                    if let errorMessage, !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: "link")
                .font(.headline)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
            Spacer(minLength: 0)
            if operation.settled {
                PendingInputButton(title: String(localized: "Done"), accessibilityLabel: String(localized: "Close connection result")) { onDismiss() }
            } else if operation.canContinue {
                PendingInputButton(title: String(localized: "Continue")) { onMove(.continueWithoutTheRest, nil) }
            }
        }
    }

    private var title: String {
        switch operation.outcome {
        case .connected: String(localized: "Connected")
        case .notConnected: String(localized: "Not Connected")
        case nil: String(localized: "Connect Apps")
        }
    }

    private func row(_ target: ConnectorOperationView.Target) -> some View {
        let isRunning = runningTargets.contains(target.name)
        return VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(target.title)
                    .font(.callout.weight(.semibold))
                Text(stateText(target.state))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)

            if !target.detail.isEmpty {
                Text(target.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let launch = target.launch {
                launchLines(launch)
            }
            ForEach(target.envFields) { field in
                PromptCredentialField(label: field.label, text: valueBinding(target: target.name, field: field.name), isSecure: field.secret)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isRunning)
            }
            actions(target, isRunning: isRunning)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("connection-target-\(target.name)")
    }

    /// What the row will run or contact, never cut, so consent reads the whole line.
    private func launchLines(_ launch: ConnectorOperationView.Launch) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(launch.kind == "remote" ? String(localized: "Connects to: \(launch.target)") : String(localized: "Runs: \(launch.target)"))
            if let cwd = launch.cwd, !cwd.isEmpty {
                Text("Working dir: \(cwd)")
            }
            if !launch.env.isEmpty {
                Text("Env: \(launch.env.joined(separator: ", "))")
            }
        }
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func actions(_ target: ConnectorOperationView.Target, isRunning: Bool) -> some View {
        let isMissingValue = target.envFields.contains { field in
            field.required && (values[target.name]?[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        HStack(spacing: 8) {
            if let url = target.connectUrl {
                PendingInputButton(title: String(localized: "Authorize"), accessibilityLabel: String(localized: "Authorize \(target.title)")) { openURL(url) }
                    .accessibilityAddTraits(.isLink)
            }
            if target.actions.contains(.approve) {
                PendingInputButton(title: String(localized: "Approve"), accessibilityLabel: String(localized: "Approve \(target.title)"), isBusy: isRunning, isDisabled: isRunning || isMissingValue) {
                    send(.approve, target: target)
                }
            }
            if target.actions.contains(.retry) {
                PendingInputButton(title: String(localized: "Try Again"), accessibilityLabel: String(localized: "Try again \(target.title)"), isBusy: isRunning, isDisabled: isRunning || isMissingValue) {
                    send(.retry, target: target)
                }
            }
            if target.actions.contains(.skip) {
                PendingInputButton(title: String(localized: "Skip"), accessibilityLabel: String(localized: "Skip \(target.title)"), isDisabled: isRunning) {
                    values[target.name] = nil
                    onMove(.row(.skip, target: target.name), nil)
                }
            }
        }
    }

    /// Sends what the row asked for, then forgets it.
    private func send(_ action: ConnectorOperationView.Action, target: ConnectorOperationView.Target) {
        let typed = values[target.name]?.filter { name, value in
            !value.isEmpty && target.envFields.contains { $0.name == name }
        } ?? [:]
        values[target.name] = nil
        onMove(.row(action, target: target.name), typed.isEmpty ? nil : typed)
    }

    private func valueBinding(target: String, field: String) -> Binding<String> {
        Binding(
            get: { values[target]?[field] ?? "" },
            set: { values[target, default: [:]][field] = $0 }
        )
    }

    private func stateText(_ state: String) -> String {
        switch state {
        case "pending": String(localized: "Starting")
        case "initiated": String(localized: "Waiting for authorization")
        case "connected": String(localized: "Connected")
        case "skipped": String(localized: "Skipped")
        case "failed": String(localized: "Failed")
        case "expired": String(localized: "Link expired")
        case "not_connected": String(localized: "Not connected")
        default: state
        }
    }
}

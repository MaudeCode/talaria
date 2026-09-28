import SwiftUI
import TalariaKit

/// Newest-first paged run list under the task's recent output.
struct TaskRunHistorySection: View {
    let viewModel: TaskDetailViewModel
    let onSelect: (CronRunSummary) -> Void
    let onLoadMore: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Run History")
                    .font(.headline)
                if let total = viewModel.runsTotal {
                    Text("\(total) runs")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if viewModel.isLoadingRuns && viewModel.runs.isEmpty {
                ProgressView("Loading history...")
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if viewModel.runs.isEmpty, viewModel.runsErrorMessage == nil {
                Text("No runs recorded yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach(viewModel.runs) { run in
                Button {
                    onSelect(run)
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(run.displayTitle)
                                .font(.subheadline.weight(.semibold))
                            if let subtitle = run.displaySubtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 6)
                .accessibilityIdentifier("task-run-\(run.filename ?? "")")
            }

            if let errorMessage = viewModel.runsErrorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Retry History", action: onRetry)
                    .font(.footnote)
            } else if viewModel.hasMoreRuns {
                Button(action: onLoadMore) {
                    if viewModel.isLoadingRuns {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Load More Runs")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isLoadingRuns)
            }
        }
    }
}

/// One run's full output with copy and retry.
struct TaskRunOutputSheet: View {
    let viewModel: TaskDetailViewModel
    let run: CronRunSummary
    let onRetry: () -> Void
    let onDismiss: () -> Void

    @State private var didCopy = false

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoadingRunDetail {
                    ProgressView("Loading output...")
                } else if let errorMessage = viewModel.runDetailErrorMessage {
                    ContentUnavailableView {
                        Label("Could Not Load Run", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again", action: onRetry)
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if let subtitle = run.displaySubtitle {
                                Text(subtitle)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if let content, !content.isEmpty {
                                Text(content)
                                    .font(.system(.body, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(12)
                                    .background(Color(.secondarySystemBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            } else {
                                Text("Empty output")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle(run.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done", action: onDismiss)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = content
                        didCopy = true
                    } label: {
                        Label(didCopy ? "Copied" : "Copy Output", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(content?.isEmpty != false)
                }
            }
        }
    }

    private var content: String? {
        viewModel.selectedRunDetail?.content ?? viewModel.selectedRunDetail?.snippet
    }
}

extension CronRunSummary {
    /// Output files are named by run time; prefer the server's mtime when present.
    var displayTitle: String {
        if let modified {
            return modified.formatted
        }
        let stem = (filename ?? "").replacingOccurrences(of: ".md", with: "")
        return stem.isEmpty ? String(localized: "Untitled run") : stem.replacingOccurrences(of: "_", with: " ")
    }

    var displaySubtitle: String? {
        var parts: [String] = []
        if let size {
            parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
        }
        if let usage, let usageText = usage.summaryText {
            parts.append(usageText)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension CronRunUsage {
    var summaryText: String? {
        var parts: [String] = []
        if let totalTokens {
            parts.append(String(localized: "\(totalTokens.formatted()) tokens"))
        }
        if let estimatedCostUsd {
            parts.append(estimatedCostUsd.formatted(.currency(code: "USD").precision(.fractionLength(2...4))))
        }
        if let durationSeconds {
            parts.append(Duration.seconds(durationSeconds).formatted(.units(allowed: [.minutes, .seconds], width: .narrow)))
        }
        if let model, !model.isEmpty {
            parts.append(model)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

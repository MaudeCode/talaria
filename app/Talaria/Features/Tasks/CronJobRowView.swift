import SwiftUI
import TalariaKit

struct CronJobRowView: View {
    let job: CronJob
    let runningElapsed: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(job.displayName)
                    .font(.headline)
                    .lineLimit(2)

                Spacer(minLength: 8)

                StatusBadge(
                    text: runningElapsed == nil ? job.status.label : String(localized: "Running"),
                    color: statusColor
                )
            }

            if let prompt = job.prompt, !prompt.isEmpty {
                Text(prompt)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            VStack(alignment: .leading, spacing: 6) {
                CronJobMetadataRow(
                    title: String(localized: "Schedule"),
                    value: job.scheduleText ?? String(localized: "Not available")
                )

                CronJobMetadataRow(
                    title: String(localized: "Next"),
                    value: job.nextRunAt?.formatted ?? String(localized: "Not available")
                )

                CronJobMetadataRow(
                    title: String(localized: "Last"),
                    value: job.lastRunAt?.formatted ?? String(localized: "Never")
                )

                if let runningElapsed {
                    CronJobMetadataRow(
                        title: String(localized: "Elapsed"),
                        value: Self.elapsedText(runningElapsed)
                    )
                }

                CronJobMetadataRow(
                    title: String(localized: "Deliver"),
                    value: job.deliver ?? "local"
                )

                if let model = job.model, !model.isEmpty {
                    CronJobMetadataRow(title: String(localized: "Model"), value: model)
                }

                if let provider = job.provider, !provider.isEmpty {
                    CronJobMetadataRow(title: String(localized: "Provider"), value: provider)
                }

                if let profile = job.profile, !profile.isEmpty {
                    CronJobMetadataRow(title: String(localized: "Profile"), value: profile)
                }

                if let skills = job.skills, !skills.isEmpty {
                    CronJobMetadataRow(title: String(localized: "Skills"), value: skills.joined(separator: ", "))
                }

                if let error = job.lastError ?? job.lastDeliveryError, !error.isEmpty {
                    CronJobMetadataRow(title: String(localized: "Error"), value: error)
                        .foregroundStyle(.red)
                }
            }
            .font(.footnote)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var statusColor: Color {
        if runningElapsed != nil {
            return .blue
        }

        switch job.status {
        case .active:
            return .green
        case .paused, .off:
            return .orange
        case .error:
            return .red
        case .needsAttention:
            return .yellow
        }
    }

    private static func elapsedText(_ elapsed: Double) -> String {
        if elapsed < 60 {
            return "\(Int(elapsed.rounded()))s"
        }

        let minutes = Int(elapsed / 60)
        let seconds = Int(elapsed.truncatingRemainder(dividingBy: 60))
        return "\(minutes)m \(seconds)s"
    }
}

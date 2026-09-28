import SwiftUI
import TalariaKit

struct ProviderRow: View {
    let provider: ProviderSummary
    let displayName: String
    let isActive: Bool
    let isHiddenFromInsights: Bool
    let canChangeInsightsVisibility: Bool
    let isExpanded: Bool
    let toggleExpanded: () -> Void
    let toggleInsightsVisibility: () -> Void
    let rename: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                ProviderIconView(providerID: provider.id, label: displayName, size: 20)

                Text(displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                if isActive {
                    Text("Active")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.green.opacity(0.16)))
                        .foregroundStyle(.green)
                }

                Spacer(minLength: 0)

                if let badge = ProvidersViewModel.keySourceBadge(for: provider) {
                    // Technical token (env / OAuth / config) — deliberately not localized.
                    Text(verbatim: badge)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                        .foregroundStyle(.secondary)
                }

                Button(action: toggleInsightsVisibility) {
                    Image(systemName: isHiddenFromInsights ? "eye" : "eye.slash")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .disabled(!canChangeInsightsVisibility)
                .accessibilityLabel(
                    isHiddenFromInsights
                        ? "Show \(displayName) in Insights"
                        : "Hide \(displayName) from Insights"
                )

                Button(action: rename) {
                    Image(systemName: "pencil")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .disabled(!canChangeInsightsVisibility)
                .accessibilityLabel("Rename \(displayName)")
            }

            keyStatusLine

            if let authError = ProvidersViewModel.authErrorText(for: provider) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityHidden(true)

                    Text(authError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.leading)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Authentication error: \(authError)"))
            }

            if let models = provider.models, !models.isEmpty {
                modelsDisclosure(models)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    @ViewBuilder
    private var keyStatusLine: some View {
        if let hasKey = provider.hasKey {
            HStack(spacing: 6) {
                Image(systemName: hasKey ? "checkmark.seal.fill" : "key.slash")
                    .font(.caption)
                    .foregroundStyle(hasKey ? Color.green : Color.secondary)
                    .accessibilityHidden(true)

                Text(hasKey ? "Key configured" : "No key")
                    .font(.footnote)
                    .foregroundStyle(hasKey ? Color.primary : Color.secondary)
            }
        }
    }

    @ViewBuilder
    private func modelsDisclosure(_ models: [ProviderModel]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: toggleExpanded) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)

                    Text("Models (\(ProvidersViewModel.modelCount(for: provider)))")
                        .font(.footnote.weight(.medium))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows this provider's model list.")

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(models.enumerated()), id: \.offset) { _, model in
                        if let title = modelTitle(model) {
                            Text(verbatim: title)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let info = ProvidersViewModel.truncatedModelInfo(for: provider) {
                        Text("Showing \(info.shown) of \(info.total) models")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 2)
                    }
                }
                .padding(.leading, 18)
            }
        }
    }

    private func modelTitle(_ model: ProviderModel) -> String? {
        let label = model.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return label
        }

        let id = model.id?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let id, !id.isEmpty {
            return id
        }

        return nil
    }
}

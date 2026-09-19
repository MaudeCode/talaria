import SwiftUI

struct ProviderQuotaGaugeView: View {
    let providerID: String?
    let displayName: String
    let sourceStatus: String
    let state: ProviderQuotaPresentationState
    let statusText: ProviderQuotaWidgetStatusText
    let resetDisplay: ProviderQuotaWidgetResetDisplay
    let style: ProviderQuotaGaugeStyle
    let compact: Bool

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.125, to: 0.875)
                .stroke(baseTrackColor, style: arcStyle)
                .rotationEffect(.degrees(90))

            if let percent = state.percent {
                Circle()
                    .trim(from: 0.125, to: 0.125 + 0.75 * percent / 100)
                    .stroke(style.arcColor, style: arcStyle)
                    .rotationEffect(.degrees(90))
                    .widgetAccentable()
            }

            if style.showsPaceMarker, let expectedPercent = state.expectedPercent {
                paceMarker(expectedPercent: expectedPercent)
            }

            VStack(spacing: compact ? 1 : 3) {
                if style.showsProviderIcon {
                    ProviderIconView(
                        providerID: providerID,
                        label: displayName,
                        size: compact ? 20 : 26,
                        style: style.providerIconStyle
                    )
                }

                Text(displayName)
                    .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.68)
                    .multilineTextAlignment(.center)

                if let percent = state.percent {
                    Text(percent, format: .percent.scale(1).precision(.fractionLength(0...1)))
                        .font(compact ? .headline : .title2.bold())
                        .monospacedDigit()
                        .minimumScaleFactor(0.72)

                    if let secondaryLabel {
                        Text(secondaryLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                } else {
                    Text(ProviderQuotaPresentation.statusLabel(sourceStatus))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(compact ? 14 : 19)
            .offset(y: style.showsProviderIcon ? (compact ? -10 : -14) : 0)

            if state.percent != nil, let resetLabel {
                Text(resetLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .padding(.horizontal, compact ? 4 : 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityIdentifier("provider-quota-widget-classic")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var arcStyle: StrokeStyle {
        StrokeStyle(lineWidth: style.lineWidth, lineCap: .round)
    }

    private var baseTrackColor: Color {
        state.percent == nil ? style.arcColor.opacity(0.55) : style.trackColor
    }

    private var secondaryLabel: String? {
        switch statusText {
        case .hidden: nil
        case .appDefault, .percentage: state.modeLabel
        case .pace: state.paceLabel
        }
    }

    private var resetLabel: String? {
        guard resetDisplay != .hidden, let resetAt = state.resetAt else { return nil }
        if resetDisplay == .exact {
            return String(localized: "Resets \(resetAt.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
        }
        let minutes = max(0, Int(resetAt.timeIntervalSince(state.referenceDate) / 60))
        let days = minutes / (24 * 60)
        let hours = minutes % (24 * 60) / 60
        if days > 0 { return String(localized: "Resets \(days)d \(hours)h") }
        if hours > 0 { return String(localized: "Resets \(hours)h \(minutes % 60)m") }
        return String(localized: "Resets \(minutes)m")
    }

    private func paceMarker(expectedPercent: Double) -> some View {
        let position = 0.125 + 0.75 * min(max(expectedPercent, 0), 100) / 100
        let halfWidth = compact ? 0.004 : 0.003
        return Circle()
            .trim(from: max(0.125, position - halfWidth), to: min(0.875, position + halfWidth))
            .stroke(Color.primary, style: StrokeStyle(lineWidth: style.lineWidth + 1, lineCap: .butt))
            .rotationEffect(.degrees(90))
            .allowsHitTesting(false)
    }

    private var accessibilityLabel: String {
        guard let percent = state.percent else {
            return "\(displayName), \(ProviderQuotaPresentation.statusLabel(sourceStatus))"
        }
        let value = percent.formatted(.percent.scale(1).precision(.fractionLength(0...1)))
        let stale = state.isStale ? String(localized: ", stale") : ""
        return "\(displayName), \(value) \(state.modeLabel)\(stale)"
    }
}

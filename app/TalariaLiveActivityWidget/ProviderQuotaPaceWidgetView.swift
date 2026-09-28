import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaPaceWidgetView: View {
    let entry: ProviderQuotaTimelineEntry

    var body: some View {
        Group {
            if let source {
                ProviderQuotaLockScreenPaceView(source: source, referenceDate: entry.date)
            } else {
                Label("Configure quota pace", systemImage: "gauge.with.dots.needle.33percent")
                    .font(.caption)
            }
        }
        .widgetURL(source.flatMap { TalariaDeepLink.quotaSourceURL(sourceID: $0.sourceID) })
        .containerBackground(.clear, for: .widget)
    }

    private var source: ProviderQuotaWidgetSource? {
        let sourceIDs = ProviderQuotaWidgetSelection.sourceIDs(
            slotIDs: entry.configuration.sourceIDs,
            capacity: 1
        )
        return ProviderQuotaWidgetSelection.resolve(sourceIDs: sourceIDs, snapshot: entry.snapshot)
            .first ?? nil
    }
}

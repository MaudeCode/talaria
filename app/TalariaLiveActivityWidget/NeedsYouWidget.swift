import SwiftUI
import TalariaKit
import WidgetKit

/// TAL-1479: the chats waiting on the user, for the Lock Screen (the closed Duo's outer display too) and the Home
/// Screen. The App writes the server's waiting rows to `NeedsYouSnapshotStore`; this renders them as they come.
struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: NeedsYouSnapshotStore.widgetKind, provider: NeedsYouTimelineProvider()) { entry in
            NeedsYouWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Needs you")
        .description("Chats waiting for your approval or answer.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .systemSmall])
    }
}

struct NeedsYouTimelineEntry: TimelineEntry {
    let date: Date
    let snapshot: NeedsYouSnapshot?
}

/// Each App write reloads the timeline; the second entry mutes the rows once the snapshot goes stale.
struct NeedsYouTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> NeedsYouTimelineEntry {
        NeedsYouTimelineEntry(date: .now, snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (NeedsYouTimelineEntry) -> Void) {
        completion(NeedsYouTimelineEntry(date: .now, snapshot: NeedsYouSnapshotStore().load() ?? (context.isPreview ? .preview : nil)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NeedsYouTimelineEntry>) -> Void) {
        let now = Date.now
        let snapshot = NeedsYouSnapshotStore().load()
        var entries = [NeedsYouTimelineEntry(date: now, snapshot: snapshot)]
        if let snapshot, !snapshot.isStale(at: now) {
            entries.append(NeedsYouTimelineEntry(
                date: snapshot.updatedAt.addingTimeInterval(NeedsYouSnapshot.staleAfter + 1), snapshot: snapshot
            ))
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

private struct NeedsYouWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NeedsYouTimelineEntry

    var body: some View {
        NeedsYouWidgetView(snapshot: entry.snapshot, date: entry.date, family: family)
    }
}

struct NeedsYouWidgetView: View {
    let snapshot: NeedsYouSnapshot?
    let date: Date
    let family: WidgetFamily

    static let smallRowLimit = 3

    var body: some View {
        content
            .widgetURL(widgetURL)
            .widgetContainerBackground(for: family)
            .liveActivityPalette(on: .system)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            Text(inlineText)
        case .accessoryCircular:
            circular
        case .accessoryRectangular:
            rectangular
        default:
            small
        }
    }

    private var circular: some View {
        VStack(spacing: 0) {
            SandalMark(height: count == 0 ? 24 : 13)
            if count > 0 {
                Text(count, format: .number)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(isStale ? .secondary : .primary)
                    .minimumScaleFactor(0.6)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(inlineText))
    }

    @ViewBuilder
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                SandalMark(height: 12)
                Text(verbatim: rows.first?.title ?? String(localized: "Nothing needs you"))
                    .font(.headline)
                    .lineLimit(1)
            }
            if let first = rows.first {
                status(first)
            }
            if let moreText = moreText(shown: 1) {
                Text(moreText).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SandalMark(height: 14)
                Text("Needs you").font(.headline)
                Spacer(minLength: 0)
                if count > 0 {
                    Text(count, format: .number)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }
            }
            if count == 0 {
                Text("Nothing needs you").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(rows.prefix(Self.smallRowLimit)) { row in
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: row.title).font(.subheadline.weight(.medium)).lineLimit(1)
                    status(row)
                }
            }
            if let moreText = moreText(shown: Self.smallRowLimit) {
                Text(moreText).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }

    /// The Live Activity's own words and hue for the phase; "Waiting" once the snapshot is stale.
    private func status(_ row: NeedsYouSnapshot.Row) -> some View {
        AggregateStatusLabel(
            status: TalariaAggregateLiveActivityPresentation.accessibilityLabel(for: row.phase),
            phase: row.phase,
            isStale: isStale
        )
    }

    var rows: [NeedsYouSnapshot.Row] { snapshot?.rows ?? [] }

    /// The server's count, which can exceed the rows it sent.
    var count: Int { snapshot?.waitingCount ?? 0 }

    var isStale: Bool { snapshot?.isStale(at: date) ?? false }

    var widgetURL: URL? { snapshot?.widgetURL ?? TalariaDeepLink.openAppURL }

    var inlineText: String {
        if count == 0 { return String(localized: "Nothing needs you") }
        if isStale { return String(localized: "Waiting") }
        return String(localized: "\(count) chats need you")
    }

    func moreText(shown: Int) -> String? {
        let more = count - min(shown, rows.count)
        return more > 0 ? String(localized: "+\(more) more") : nil
    }
}

extension View {
    /// The Lock Screen's circular backdrop, the Home Screen's system background, and nothing behind the other
    /// accessory families. Shared by the Talaria widgets.
    func widgetContainerBackground(for family: WidgetFamily) -> some View {
        containerBackground(for: .widget) {
            switch family {
            case .systemSmall: Color(uiColor: .systemBackground)
            case .accessoryCircular: AccessoryWidgetBackground()
            default: Color.clear
            }
        }
    }
}

private extension NeedsYouSnapshot {
    static var preview: NeedsYouSnapshot {
        NeedsYouSnapshot(updatedAt: .now, rows: [
            Row(sessionID: "preview-deploy", title: "Deploy fix", phase: "waiting_for_approval", serverID: nil),
            Row(sessionID: "preview-question", title: "Release notes", phase: "waiting_for_input", serverID: nil),
        ], waitingCount: 2)
    }
}

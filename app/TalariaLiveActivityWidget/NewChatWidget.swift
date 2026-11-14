import AppIntents
import SwiftUI
import TalariaKit
import WidgetKit

/// Home Screen and Lock Screen widget that opens the New Chat composer, optionally in a profile (TAL-50). A tap runs
/// the same App Intents as Shortcuts and the controls; the chat is created on the first Send, never here.
struct NewChatWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: ProfileEntityCache.newChatWidgetKind,
            intent: NewChatWidgetConfigurationIntent.self,
            provider: NewChatWidgetTimelineProvider()
        ) { entry in
            NewChatWidgetView(entry: entry)
        }
        .configurationDisplayName("New Chat")
        .description("Open Talaria on a new chat, optionally in a profile.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

/// One entry per configuration; `ProfileEntityCache` reloads the timeline when the App's profile list changes.
struct NewChatWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> NewChatWidgetEntry {
        NewChatWidgetEntry(configuration: .init(), available: [])
    }

    func snapshot(
        for configuration: NewChatWidgetConfigurationIntent,
        in context: Context
    ) async -> NewChatWidgetEntry {
        NewChatWidgetEntry(configuration: configuration, available: ProfileEntityCache.shared.loadEntities())
    }

    func timeline(
        for configuration: NewChatWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<NewChatWidgetEntry> {
        Timeline(entries: [await snapshot(for: configuration, in: context)], policy: .never)
    }
}

struct NewChatWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NewChatWidgetEntry

    var body: some View {
        Group {
            if let profile = entry.profile {
                Button(intent: NewChatInProfileIntent(profile: profile)) { content }
            } else {
                Button(intent: NewChatIntent()) { content }
            }
        }
        .buttonStyle(.plain)
        .containerBackground(for: .widget) {
            switch family {
            case .systemSmall: Color(uiColor: .systemBackground)
            case .accessoryCircular: AccessoryWidgetBackground()
            default: Color.clear
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            Label { Text(title) } icon: { Image(systemName: symbol) }
        case .accessoryCircular:
            Image(systemName: symbol)
                .font(.title2)
                .accessibilityLabel(Text(title))
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Label("New Chat", systemImage: symbol).font(.headline)
                detail.font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        default:
            if let name = entry.missingProfileName {
                ProviderQuotaWidgetPrompt(
                    title: "\(name) not found", detail: "Choose a profile in Edit Widget.", systemImage: symbol
                )
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Image(systemName: symbol)
                        .font(.title)
                        .foregroundStyle(.tint)
                    Spacer(minLength: 0)
                    Text("New Chat").font(.headline)
                    if let name = entry.profile?.name {
                        Text(verbatim: name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var symbol: String { "square.and.pencil" }

    private var title: LocalizedStringResource {
        entry.profile.map { "New Chat in \($0.name)" } ?? "New Chat"
    }

    /// The Lock Screen's second line: the profile, or why it is gone.
    @ViewBuilder
    private var detail: some View {
        if let name = entry.missingProfileName {
            Text("\(name) not found")
        } else if let name = entry.profile?.name {
            Text(verbatim: name)
        }
    }
}

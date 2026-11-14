import AppIntents
import SwiftUI
import TalariaKit
import WidgetKit

/// Home Screen and Lock Screen widget that opens the New Chat composer, optionally in a profile (TAL-50). A tap runs
/// the same App Intents as Shortcuts and the controls; the chat is created on the first Send, never here, and the
/// server refuses a profile it no longer has on that Send.
struct NewChatWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "NewChatWidget",
            intent: NewChatWidgetConfigurationIntent.self,
            provider: NewChatWidgetTimelineProvider()
        ) { entry in
            NewChatWidgetView(profile: entry.profile)
        }
        .configurationDisplayName("New Chat")
        .description("Open Talaria on a new chat, optionally in a profile.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct NewChatWidgetEntry: TimelineEntry {
    let date: Date
    let profile: ProfileEntity?
}

/// One entry per configuration; the widget shows nothing that changes over time.
struct NewChatWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> NewChatWidgetEntry {
        NewChatWidgetEntry(date: .now, profile: nil)
    }

    func snapshot(
        for configuration: NewChatWidgetConfigurationIntent,
        in context: Context
    ) async -> NewChatWidgetEntry {
        NewChatWidgetEntry(date: .now, profile: configuration.profile)
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
    let profile: ProfileEntity?

    var body: some View {
        Group {
            if let profile {
                Button(intent: NewChatInProfileIntent(profile: profile)) { content }
            } else {
                Button(intent: NewChatIntent()) { content }
            }
        }
        .buttonStyle(.plain)
        .widgetURL(deepLink)
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
                if let name = profile?.name {
                    Text(verbatim: name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        default:
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: symbol)
                    .font(.title)
                    .foregroundStyle(.tint)
                Spacer(minLength: 0)
                Text("New Chat").font(.headline)
                if let name = profile?.name {
                    Text(verbatim: name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    /// The inline Lock Screen family takes no buttons; a tap there opens the same deep link the intent requests.
    private var deepLink: URL? {
        profile.flatMap { TalariaDeepLink.newChatInProfileURL(profileName: $0.id) } ?? TalariaDeepLink.newChatURL
    }

    private var symbol: String { "square.and.pencil" }

    private var title: LocalizedStringResource {
        profile.map { "New Chat in \($0.name)" } ?? "New Chat"
    }
}

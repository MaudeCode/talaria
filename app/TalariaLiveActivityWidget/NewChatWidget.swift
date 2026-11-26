import AppIntents
import SwiftUI
import TalariaKit
import UIKit
import WidgetKit

/// The Home Screen can open a profile's Bot Chat. New Chat keeps its existing Home Screen and Lock Screen actions.
struct NewChatWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: ProfileEntityCache.widgetKind,
            intent: NewChatWidgetConfigurationIntent.self,
            provider: NewChatWidgetTimelineProvider()
        ) { entry in
            NewChatWidgetView(entry: entry)
        }
        .configurationDisplayName("New Chat")
        .description("Open a new chat or go straight to a profile's Bot Chat.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .lockedIPhoneUse(Self.lockedIPhoneUse)
    }

    /// The composer needs the iPhone unlocked.
    static let lockedIPhoneUse = LockedIPhoneUse.opensApp
}

struct NewChatWidgetEntry: TimelineEntry {
    struct BotProfile: Identifiable {
        let url: URL
        let name: String
        let avatar: Data?
        var id: URL { url }
    }

    let date: Date
    let family: WidgetFamily
    let profile: ProfileEntity?
    let opensBotChat: Bool
    let botProfiles: [BotProfile]
    var botLinks: [URL] { botProfiles.map(\.url) }

    init(configuration: NewChatWidgetConfigurationIntent = .init(), family: WidgetFamily) {
        date = .now
        self.family = family
        profile = configuration.profile
        opensBotChat = family == .systemMedium || (family == .systemSmall && configuration.open == .botChat)
        let selected = family == .systemMedium
            ? [configuration.botProfile, configuration.secondBotProfile, configuration.thirdBotProfile, configuration.fourthBotProfile]
            : [configuration.botProfile]
        var seen = Set<URL>()
        botProfiles = opensBotChat ? selected.compactMap { profile in
            guard let profile, let url = URL(string: profile.id), let route = TalariaDeepLink.botChat(from: url),
                  seen.insert(url).inserted else { return nil }
            let avatar = ProfileEntityCache.shared.botChatAvatars(publisherID: route.publisherID)[route.profileName]
            return BotProfile(url: url, name: profile.name, avatar: avatar)
        } : []
    }
}

/// One entry per configuration; the widget shows nothing that changes over time.
struct NewChatWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> NewChatWidgetEntry {
        NewChatWidgetEntry(family: context.family)
    }

    func snapshot(
        for configuration: NewChatWidgetConfigurationIntent,
        in context: Context
    ) async -> NewChatWidgetEntry {
        NewChatWidgetEntry(configuration: configuration, family: context.family)
    }

    func timeline(
        for configuration: NewChatWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<NewChatWidgetEntry> {
        Timeline(entries: [await snapshot(for: configuration, in: context)], policy: .never)
    }
}

struct NewChatWidgetView: View {
    let entry: NewChatWidgetEntry
    private var family: WidgetFamily { entry.family }
    private var profile: ProfileEntity? { entry.profile }

    var body: some View {
        Group {
            if family == .systemMedium {
                mediumBotChat
            } else if entry.opensBotChat {
                content.widgetURL(entry.botLinks.first)
            } else {
                newChatAction.widgetURL(newChatDeepLink)
            }
        }
        .buttonStyle(.plain)
        .widgetContainerBackground(for: family)
    }

    @ViewBuilder
    private var newChatAction: some View {
        if let profile {
            Button(intent: NewChatInProfileIntent(profile: profile)) { content }
        } else {
            Button(intent: NewChatIntent()) { content }
        }
    }

    private var mediumBotChat: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Bot Chat").font(.headline)
            if entry.botProfiles.isEmpty {
                Text("Choose profiles in Edit Widget").font(.caption).foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 8) {
                    ForEach(entry.botProfiles) { profile in
                        Link(destination: profile.url) {
                            HStack(spacing: 6) {
                                avatar(profile, size: 28)
                                Text(verbatim: profile.name).font(.subheadline).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .accessibilityLabel(profile.name)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func avatar(_ profile: NewChatWidgetEntry.BotProfile?, size: CGFloat) -> some View {
        Group {
            if let data = profile?.avatar, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "bubble.left.circle.fill")
                    .font(.system(size: size))
                    .foregroundStyle(.tint)
                    .widgetAccentable()
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
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
            let bot = entry.botProfiles.first
            let heading: LocalizedStringKey = entry.opensBotChat ? "Bot Chat" : "New Chat"
            VStack(alignment: .leading, spacing: 4) {
                if entry.opensBotChat {
                    avatar(bot, size: 38)
                } else {
                    Image(systemName: symbol)
                        .font(.title)
                        .foregroundStyle(.tint)
                }
                Spacer(minLength: 0)
                Text(heading).font(.headline)
                if let name = entry.opensBotChat ? bot?.name : profile?.name {
                    Text(verbatim: name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                } else if entry.opensBotChat {
                    Text("Choose a profile in Edit Widget").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    /// The inline Lock Screen family takes no buttons; a tap there opens the same deep link the intent requests.
    private var newChatDeepLink: URL? {
        profile.flatMap { TalariaDeepLink.newChatInProfileURL(profileName: $0.id) } ?? TalariaDeepLink.newChatURL
    }

    private var symbol: String { "square.and.pencil" }

    private var title: LocalizedStringResource {
        profile.map { "New Chat in \($0.name)" } ?? "New Chat"
    }
}

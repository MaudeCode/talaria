import Foundation
import UniformTypeIdentifiers

public struct ShareInput: Sendable {
    public var textSnippets: [String] = []
    public var urls: [URL] = []
    public var attachments: [SharedAttachmentImport] = []
}

public enum ShareInputReader: Sendable {
    public static func input(from context: NSExtensionContext?) async throws -> ShareInput {
        let providers = context?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] } ?? []

        return try await input(from: providers)
    }

    // Provider-array entry point so unit tests can exercise parsing without an
    // NSExtensionContext (which can't be constructed outside an extension host).
    //
    // Throws `SharedDraftStoreError.totalAttachmentBytesExceeded` as soon as the
    // retained attachments plus the one just read would exceed the aggregate
    // limit, so the extension never holds the full oversized set in memory and
    // never hands the app a silently partial draft.
    public static func input(from providers: [NSItemProvider]) async throws -> ShareInput {
        var input = ShareInput()
        var remainingBytes = TalariaShareDraft.maximumSharedImportBytes
        for provider in providers {
            if let url = await loadURL(from: provider) {
                input.urls.append(url)
            }

            if let text = await loadText(from: provider) {
                input.textSnippets.append(text)
            }

            if input.attachments.count < TalariaShareDraft.maximumSharedAttachmentCount,
               let attachment = await loadAttachment(from: provider) {
                guard attachment.data.count <= remainingBytes else {
                    throw SharedDraftStoreError.totalAttachmentBytesExceeded(
                        maximumBytes: TalariaShareDraft.maximumSharedImportBytes
                    )
                }

                remainingBytes -= attachment.data.count
                input.attachments.append(attachment)
            }
        }

        return input
    }

    private static func loadURL(from provider: NSItemProvider) async -> URL? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) else {
            return nil
        }

        switch await loadItem(from: provider, typeIdentifier: UTType.url.identifier) {
        case .url(let url):
            return webURL(url)
        case .string(let string):
            return webURL(URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)))
        case .data(let data):
            return String(data: data, encoding: .utf8)
                .flatMap { webURL(URL(string: $0.trimmingCharacters(in: .whitespacesAndNewlines))) }
        case .attributedText, nil:
            return nil
        }
    }

    private static func loadText(from provider: NSItemProvider) async -> String? {
        let typeIdentifier = [UTType.plainText.identifier, UTType.text.identifier]
            .first { provider.hasItemConformingToTypeIdentifier($0) }

        guard let typeIdentifier else {
            return nil
        }

        switch await loadItem(from: provider, typeIdentifier: typeIdentifier) {
        case .string(let string), .attributedText(let string):
            return string
        case .data(let data):
            return String(data: data, encoding: .utf8)
        case .url, nil:
            return nil
        }
    }

    private static func webURL(_ url: URL?) -> URL? {
        guard let url, !url.isFileURL else {
            return nil
        }

        return url
    }

    private static func loadAttachment(from provider: NSItemProvider) async -> SharedAttachmentImport? {
        if let fileAttachment = await loadFileAttachment(from: provider) {
            return fileAttachment
        }

        return await loadDataAttachment(from: provider)
    }

    private static func loadFileAttachment(from provider: NSItemProvider) async -> SharedAttachmentImport? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) else {
            return nil
        }

        let item = await loadItem(from: provider, typeIdentifier: UTType.fileURL.identifier)
        guard let url = fileURL(from: item), url.isFileURL else {
            return nil
        }

        return attachment(from: url, provider: provider)
    }

    private static func loadDataAttachment(from provider: NSItemProvider) async -> SharedAttachmentImport? {
        guard let typeIdentifier = attachmentDataTypeIdentifier(from: provider) else {
            return nil
        }

        // A file representation is size-checked before it is read and then mapped, so an
        // over-cap item never enters the extension's memory. Only a provider that cannot
        // supply a readable file falls back to its in-memory data representation.
        let data: Data
        switch await loadFileData(from: provider, typeIdentifier: typeIdentifier) {
        case .read(let fileData):
            data = fileData
        case .oversized:
            return nil
        case .unreadable:
            guard let fallback = await loadData(from: provider, typeIdentifier: typeIdentifier),
                  fallback.count <= TalariaShareDraft.maximumSharedAttachmentBytes else {
                return nil
            }
            data = fallback
        }

        return SharedAttachmentImport(
            filename: fallbackFilename(for: provider, typeIdentifier: typeIdentifier),
            typeIdentifier: typeIdentifier,
            data: data
        )
    }

    /// The outcome of reading a shared file: `oversized` is final, `unreadable` lets a caller fall back.
    private enum FileRead: Sendable {
        case read(Data)
        case oversized
        case unreadable
    }

    /// Checks the file's size against the per-file cap before reading, then maps it rather than
    /// copying it onto the heap. Mapped bytes stay readable after the provider unlinks its copy.
    private static func readAttachmentFile(at url: URL) -> FileRead {
        let didStartAccessing = url.startAccessingSecurityScopedResource()
        defer {
            if didStartAccessing {
                url.stopAccessingSecurityScopedResource()
            }
        }

        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > TalariaShareDraft.maximumSharedAttachmentBytes {
            return .oversized
        }

        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else {
            return .unreadable
        }
        return data.count <= TalariaShareDraft.maximumSharedAttachmentBytes ? .read(data) : .oversized
    }

    private static func attachment(from url: URL, provider: NSItemProvider) -> SharedAttachmentImport? {
        guard case .read(let data) = readAttachmentFile(at: url) else {
            return nil
        }

        let typeIdentifier = attachmentTypeIdentifier(from: provider, fallbackURL: url)
        let filename = url.lastPathComponent.isEmpty
            ? fallbackFilename(for: provider, typeIdentifier: typeIdentifier)
            : url.lastPathComponent

        return SharedAttachmentImport(filename: filename, typeIdentifier: typeIdentifier, data: data)
    }

    private static func fileURL(from item: LoadedItem?) -> URL? {
        switch item {
        case .url(let url):
            return url
        case .data(let data):
            return URL(dataRepresentation: data, relativeTo: nil)
        case .string(let string):
            return URL(string: string) ?? URL(fileURLWithPath: string)
        case .attributedText, nil:
            return nil
        }
    }

    private static func attachmentDataTypeIdentifier(from provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .image) || type.conforms(to: .pdf)
        }
    }

    private static func attachmentTypeIdentifier(from provider: NSItemProvider, fallbackURL: URL) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type != .fileURL && (type.conforms(to: .image) || type.conforms(to: .pdf) || type.conforms(to: .data))
        } ?? UTType(filenameExtension: fallbackURL.pathExtension)?.identifier
    }

    private static func fallbackFilename(for provider: NSItemProvider, typeIdentifier: String?) -> String {
        let type = typeIdentifier.flatMap(UTType.init)

        if let suggestedName = provider.suggestedName,
           !suggestedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !URL(fileURLWithPath: suggestedName).pathExtension.isEmpty {
                return suggestedName
            }

            if let fileExtension = type?.preferredFilenameExtension, !fileExtension.isEmpty {
                return "\(suggestedName).\(fileExtension)"
            }

            return suggestedName
        }

        let baseName: String
        if type?.conforms(to: .image) == true {
            baseName = "shared-image"
        } else if type?.conforms(to: .pdf) == true {
            baseName = "shared-document"
        } else {
            baseName = "shared-file"
        }

        guard let fileExtension = type?.preferredFilenameExtension, !fileExtension.isEmpty else {
            return baseName
        }

        return "\(baseName).\(fileExtension)"
    }

    /// The value a provider's `NSSecureCoding` item carries, read on the provider's queue so it can cross actors.
    private enum LoadedItem: Sendable {
        case url(URL)
        case string(String)
        case attributedText(String)
        case data(Data)

        init?(_ item: NSSecureCoding?) {
            switch item {
            case let url as URL: self = .url(url)
            case let string as String: self = .string(string)
            case let attributed as NSAttributedString: self = .attributedText(attributed.string)
            case let data as Data: self = .data(data)
            default: return nil
            }
        }
    }

    private static func loadItem(from provider: NSItemProvider, typeIdentifier: String) async -> LoadedItem? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                continuation.resume(returning: LoadedItem(item))
            }
        }
    }

    /// Reads the provider's file representation inside its completion handler, before the
    /// provider deletes the temporary copy.
    private static func loadFileData(from provider: NSItemProvider, typeIdentifier: String) async -> FileRead {
        await withCheckedContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
                continuation.resume(returning: url.map(readAttachmentFile) ?? .unreadable)
            }
        }
    }

    private static func loadData(from provider: NSItemProvider, typeIdentifier: String) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }
}

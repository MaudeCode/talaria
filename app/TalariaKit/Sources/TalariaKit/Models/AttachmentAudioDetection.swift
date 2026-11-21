import Foundation
import UniformTypeIdentifiers

/// Audio detection for an attachment without the server's `kind` (TAL-2507): a device-picked or optimistic
/// attachment, or one from an older server. Mirrors `ChatAttachmentPreviewItem.isLocalImage`.
public enum AttachmentAudioDetection {
    /// File extensions we treat as audio. `AVAudioPlayer` natively decodes the
    /// first group (m4a/mp3/wav/aac/caf); ogg/oga/opus/flac are still detected
    /// as audio so they surface an audio player with a graceful "can't play"
    /// state instead of a dead file chip.
    static let audioExtensions: Set<String> = [
        "m4a", "mp3", "wav", "aac", "caf", "ogg", "oga", "opus", "flac"
    ]

    /// Audio when the attachment is *not* an image and either its MIME type
    /// starts with `audio/` or its filename carries a known audio extension.
    /// The explicit `isImage == true` server flag always wins, so an image is
    /// never misclassified as audio.
    public static func isAudio(isImage: Bool?, mime: String?, name: String?, path: String?) -> Bool {
        if isImage == true { return false }

        if let mime = mime?.lowercased(), mime.hasPrefix("audio/") {
            return true
        }

        // Check the display name first, then fall back to the path: a human
        // display name like "Voice note" carries no extension even when the
        // path ends in `.m4a`, so a single `name ?? path` candidate would miss it.
        for candidate in [name, path] {
            let ext = URL(fileURLWithPath: candidate ?? "").pathExtension.lowercased()
            if audioExtensions.contains(ext) { return true }
        }
        return false
    }

    /// The audio container `data` starts with, read from its first 12 bytes: WAV, MP3 (ID3 tag or frame sync), CAF,
    /// FLAC, Ogg, AIFF, or MPEG-4 audio. An MPEG-4 file with a generic brand (`isom`, `mp42`) is audio when its track
    /// handlers include sound and no video. Bytes the server could not type are checked here before any image decode,
    /// so audio never reaches ImageIO or an `AVAudioPlayer` just to be recognized (TAL-866).
    public static func containerType(of data: Data) -> (contentType: UTType, fileExtension: String)? {
        let header = Array(data.prefix(12))
        func has(_ magic: String, at offset: Int = 0) -> Bool {
            let bytes = Array(magic.utf8)
            return header.count >= offset + bytes.count && Array(header[offset..<offset + bytes.count]) == bytes
        }
        let fileExtension: String
        if has("RIFF"), has("WAVE", at: 8) {
            fileExtension = "wav"
        } else if has("ID3") || (header.count >= 2 && header[0] == 0xFF && header[1] & 0xE0 == 0xE0) {
            fileExtension = "mp3"
        } else if has("caff") {
            fileExtension = "caf"
        } else if has("ftyp", at: 4), has("M4A", at: 8) || isAudioOnlyMPEG4(data) {
            fileExtension = "m4a"
        } else if has("fLaC") {
            fileExtension = "flac"
        } else if has("OggS") {
            fileExtension = "ogg"
        } else if has("FORM"), has("AIFF", at: 8) || has("AIFC", at: 8) {
            fileExtension = "aiff"
        } else {
            return nil
        }
        return (UTType(filenameExtension: fileExtension, conformingTo: .audio) ?? .audio, fileExtension)
    }

    /// Whether an MPEG-4 file's track handlers (`hdlr` boxes) include sound and no video, so an audio-only file under a
    /// generic brand is audio while a movie, or a HEIF image's `pict` track, is not.
    private static func isAudioOnlyMPEG4(_ data: Data) -> Bool {
        var handlers: Set<Data> = []
        var searchStart = data.startIndex
        while let box = data.range(of: Data("hdlr".utf8), in: searchStart..<data.endIndex) {
            // Version and flags, then `pre_defined`, precede the handler type.
            let type = box.upperBound + 8
            if type + 4 <= data.endIndex { handlers.insert(data[type..<type + 4]) }
            searchStart = box.upperBound
        }
        return handlers.contains(Data("soun".utf8)) && !handlers.contains(Data("vide".utf8))
    }
}

/// Formats a playback offset/duration as `m:ss` (or `h:mm:ss` past an hour).
/// Non-finite or negative inputs clamp to `0:00` so the label stays monotonic
/// and never shows `NaN`.
public enum AudioDurationFormatter {
    public static func string(from seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }

        let total = Int(seconds.rounded(.down))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }
}

extension MessageAttachment {
    /// Whether this attachment should render as a playable audio clip: the server's `kind`, else the local check.
    public var inferredIsAudio: Bool {
        if let kind { return kind == .audio }
        return AttachmentAudioDetection.isAudio(isImage: isImage, mime: mime, name: name, path: path)
    }

    /// Whether this attachment should render as an image: the server's `kind`, else the local check.
    public var inferredIsImage: Bool {
        if let kind { return kind == .image }
        return ChatAttachmentPreviewItem.isLocalImage(isImage: isImage, mime: mime, name: name, path: path)
    }
}

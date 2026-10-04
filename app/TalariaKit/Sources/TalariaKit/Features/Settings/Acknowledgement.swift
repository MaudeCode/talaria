import Foundation

/// One open-source component or separately licensed asset shipped in the App, read from the bundled
/// `ThirdPartyNotices/Acknowledgements.json` so Settings > About can show its notice offline.
public struct Acknowledgement: Decodable, Hashable, Identifiable {
    public let name: String
    public let version: String?
    /// The Swift package identity in `Package.resolved`, for components shipped as packages.
    public let package: String?
    /// Notice files in the same directory, shown in order.
    public let files: [String]

    public var id: String { name }

    public static let manifestName = "Acknowledgements.json"

    public static func load(from directory: URL) throws -> [Acknowledgement] {
        let data = try Data(contentsOf: directory.appendingPathComponent(manifestName))
        return try JSONDecoder().decode([Acknowledgement].self, from: data)
    }

    /// The component's notice files joined into one text, reflowed for the screen width.
    public func notice(in directory: URL) throws -> String {
        try files
            .map { try String(contentsOf: directory.appendingPathComponent($0), encoding: .utf8) }
            .map { Self.reflow($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .joined(separator: "\n\n")
    }

    /// Joins the hard-wrapped lines of each paragraph so a notice wraps to the screen at any text size. Copyright
    /// lines, list items, headings, rules, table rows, and `%` comments keep their own lines; blank lines keep
    /// separating paragraphs.
    static func reflow(_ text: String) -> String {
        var output = ""
        var continuesParagraph = false
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            let isRule = line.count >= 3 && line.allSatisfy { "-=".contains($0) }
            let isHeading = line.hasPrefix("#") || isCapitalizedHeading(line)
            // Table rows and `%` comment lines read line by line.
            let keepsLine = line.hasPrefix("|") || line.hasPrefix("%")
            let startsBlock = isRule || isHeading || keepsLine
                || line.firstMatch(of: /^([-*•]|\d+[.)]|\([a-z0-9]+\))\s/) != nil
                || line.firstMatch(of: /^(Portions copyright|Copyright|Copyleft)\b/) != nil
            if output.isEmpty {
                output = line
            } else if continuesParagraph, !line.isEmpty, !startsBlock {
                output += " " + line
            } else {
                output += "\n" + line
            }
            continuesParagraph = !line.isEmpty && !isRule && !isHeading && !keepsLine
        }
        return output
    }

    /// A short all-capitals line without closing punctuation, such as `DEFINITIONS`, rather than a line of an
    /// all-capitals disclaimer.
    private static func isCapitalizedHeading(_ line: String) -> Bool {
        line.contains(where: \.isLetter) && line == line.uppercased()
            && line.split(separator: " ").count <= 4 && !".,;:".contains(line.last ?? ".")
    }
}

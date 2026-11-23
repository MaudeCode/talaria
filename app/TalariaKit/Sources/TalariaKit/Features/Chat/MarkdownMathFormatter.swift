import Foundation

public struct MarkdownMathFormatter: Sendable {
    static func replacingInlineMath(in markdown: String) -> String {
        guard mayContainMath(markdown) else { return markdown }
        let characters = Array(markdown)
        #if DEBUG
        TranscriptProbeRecorder.record("mathCharacterArray")
        #endif
        guard characters.count >= 3 else { return markdown }

        let protected = MarkdownMathProtection.mask(for: characters)
        var result = ""
        var index = 0
        // A failed `\(` search covers every later `\(` on its line. A failed `$` search can stop early at another
        // `$`, so it is never remembered.
        var exhaustedParensOnLine = false

        while index < characters.count {
            if characters[index] == "\n" { exhaustedParensOnLine = false }
            guard let delimiter = inlineDelimiter(in: characters, at: index, protected: protected),
                  !(delimiter == .parens && exhaustedParensOnLine)
            else {
                result.append(characters[index])
                index += 1
                continue
            }
            guard let closeIndex = closingInlineDelimiter(
                in: characters,
                from: index + delimiter.openLength,
                protected: protected,
                delimiter: delimiter
            ) else {
                if delimiter == .parens { exhaustedParensOnLine = true }
                result.append(characters[index])
                index += 1
                continue
            }

            let latex = String(characters[(index + delimiter.openLength)..<closeIndex])
            // A `$` span ending in `/` or `:` is a shell path such as `$HOME/foo:$PATH`.
            let isShellPath = delimiter == .dollar && (latex.hasSuffix("/") || latex.hasSuffix(":"))
            if !isShellPath, looksLikeMath(latex) {
                result += InlineMathReference.markdown(for: latex) ?? renderedText(for: latex)
                index = closeIndex + delimiter.closeLength
            } else {
                result.append(characters[index])
                index += 1
            }
        }

        return result
    }

    /// Every math delimiter (`$`, `$$`, `\(`, `\[`) opens with `$` or `\`, so text with neither has nothing to format
    /// and skips the character array and code mask both passes would build.
    static func mayContainMath(_ text: String) -> Bool {
        text.utf8.contains { $0 == UInt8(ascii: "$") || $0 == UInt8(ascii: "\\") }
    }

    public static func renderedText(for latex: String) -> String {
        let normalized = latex
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\("#, with: "")
            .replacingOccurrences(of: #"\)"#, with: "")
            .replacingOccurrences(of: #"\["#, with: "")
            .replacingOccurrences(of: #"\]"#, with: "")

        var rendered = normalized
        rendered = replacingAligned(in: rendered)
        rendered = replacingCases(in: rendered)
        rendered = replacingMatrices(in: rendered)
        rendered = replacingStructuralCommands(in: rendered)
        rendered = replacingFractions(in: rendered)
        rendered = replacingSquareRoots(in: rendered)
        rendered = replacingTextCommands(in: rendered)
        rendered = replacingAccentCommands(in: rendered)
        rendered = replacingKnownCommands(in: rendered)
        rendered = replacingScripts(in: rendered)
        rendered = replacingEscapedSpacing(in: rendered)
        rendered = rendered
            .replacingOccurrences(of: #"\\"#, with: "\n")
            .replacingOccurrences(of: #"\,"#, with: " ")
            .replacingOccurrences(of: #"\;"#, with: " ")
            .replacingOccurrences(of: #"\ "#, with: " ")
            .replacingOccurrences(of: "{", with: "")
            .replacingOccurrences(of: "}", with: "")

        return normalizedWhitespace(in: rendered)
    }

    static func group(
        in characters: [Character],
        from startIndex: Int
    ) -> (value: String, endIndex: Int)? {
        guard startIndex < characters.count, characters[startIndex] == "{" else { return nil }

        var depth = 0
        var index = startIndex
        while index < characters.count {
            if characters[index] == "{", !MarkdownMathProtection.isEscaped(characters, at: index) {
                depth += 1
            } else if characters[index] == "}", !MarkdownMathProtection.isEscaped(characters, at: index) {
                depth -= 1
                if depth == 0 {
                    return (String(characters[(startIndex + 1)..<index]), index + 1)
                }
            }
            index += 1
        }

        return nil
    }

    static func isSimpleMathText(_ value: String) -> Bool {
        value.range(of: #"\s|[+\-*/=<>|·]"#, options: .regularExpression) == nil
    }

    static func matches(_ command: String, in characters: [Character], at index: Int) -> Bool {
        let commandCharacters = Array(command)
        guard index + commandCharacters.count <= characters.count else { return false }
        return Array(characters[index..<(index + commandCharacters.count)]) == commandCharacters
    }

    static func normalizedWhitespace(in value: String) -> String {
        value
            .components(separatedBy: "\n")
            .map { line in
                line
                    .replacingOccurrences(of: #"[ \t]+"#, with: " ", options: .regularExpression)
                    .replacingOccurrences(of: #"∂\s+"#, with: "∂", options: .regularExpression)
                    .trimmingCharacters(in: .whitespaces)
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func skipSpaces(in characters: [Character], from startIndex: Int) -> Int {
        var index = startIndex
        while index < characters.count, characters[index].isWhitespace {
            index += 1
        }
        return index
    }

    private static func closingInlineDelimiter(
        in characters: [Character],
        from startIndex: Int,
        protected: [Bool],
        delimiter: InlineDelimiter
    ) -> Int? {
        #if DEBUG
        TranscriptProbeRecorder.record("mathInlineCloserSearch")
        #endif
        var index = startIndex
        while index < characters.count {
            if characters[index] == "\n" {
                return nil
            }

            if delimiter.isClose(in: characters, at: index, protected: protected) {
                return index
            }

            // A live `$` that cannot close ends the candidate: scanning past it would pair
            // with a later `$` and swallow the prose between, as with `$5 … and $10`.
            if delimiter == .dollar, characters[index] == "$", !protected[index],
               !MarkdownMathProtection.isEscaped(characters, at: index) {
                return nil
            }

            index += 1
        }
        return nil
    }

    private static func inlineDelimiter(
        in characters: [Character],
        at index: Int,
        protected: [Bool]
    ) -> InlineDelimiter? {
        for delimiter in InlineDelimiter.allCases where delimiter.isOpen(in: characters, at: index, protected: protected) {
            return delimiter
        }
        return nil
    }

    static func looksLikeMath(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed.range(of: identifierPattern, options: .regularExpression) != nil {
            return true
        }
        if trimmed.contains("\\") || trimmed.contains("^") || trimmed.contains("_") { return true }
        if trimmed.range(of: numericTuplePattern, options: .regularExpression) != nil { return true }
        if trimmed.range(of: #"[A-Za-z0-9]\s*[=<>+\-*/|]\s*[A-Za-z0-9]"#, options: .regularExpression) != nil {
            return true
        }
        return looksLikeGroupedAssignment(trimmed)
    }

    /// Assignments whose right-hand side opens with a group, such as `E=[4,-2]`.
    /// The operator heuristic above misses them because the character after `=`
    /// is a bracket rather than an alphanumeric.
    private static func looksLikeGroupedAssignment(_ value: String) -> Bool {
        let sides = value.components(separatedBy: "=")
        guard sides.count == 2,
              sides[0].trimmingCharacters(in: .whitespaces)
                .range(of: identifierPattern, options: .regularExpression) != nil
        else { return false }

        let rightHandSide = sides[1].trimmingCharacters(in: .whitespaces)
        guard let opener = rightHandSide.first, groupPairs[opener] != nil,
              rightHandSide.unicodeScalars.allSatisfy(groupedAssignmentCharacters.contains),
              rightHandSide.range(of: #"[0-9,+\-*/|]"#, options: .regularExpression) != nil
        else { return false }

        return isBalanced(rightHandSide)
    }

    private static func isBalanced(_ value: String) -> Bool {
        var expected: [Character] = []
        for character in value {
            if let closer = groupPairs[character] {
                expected.append(closer)
            } else if groupPairs.values.contains(character), expected.popLast() != character {
                return false
            }
        }
        return expected.isEmpty
    }

    private static let identifierPattern = #"^[A-Za-z](?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?$"#

    /// A point such as `(4,-2)`: two or more signed numbers in parentheses. A lone price never opens a span.
    private static let numericTuplePattern = #"^\(\s*[+-]?\d+(?:\.\d+)?(?:\s*,\s*[+-]?\d+(?:\.\d+)?)+\s*\)$"#

    private static let groupPairs: [Character: Character] = ["[": "]", "(": ")", "{": "}"]

    private static let groupedAssignmentCharacters = CharacterSet.alphanumerics
        .union(.whitespaces)
        .union(CharacterSet(charactersIn: #"_^,.+-*/<>|[](){}"#))
}

/// An inline expression as a Markdown image whose address carries its LaTeX, which the App draws with SwiftMath in
/// the line of text (TAL-971). The alt text is one character, as the drawn image is, so plain-text offsets such as
/// link ranges match what the line draws.
public enum InlineMathReference {
    public static let scheme = "talaria-math"
    /// Longer expressions keep the text approximation rather than a long image address.
    static let maxLaTeXBytes = 512

    static func markdown(for latex: String) -> String? {
        let source = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty, source.utf8.count <= maxLaTeXBytes else { return nil }
        let encoded = Data(source.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        return "![\u{FFFC}](\(scheme):///\(encoded))"
    }

    /// The LaTeX an inline-math image carries; nil for any other image.
    public static func latex(from url: URL?) -> String? {
        guard let url, url.scheme == scheme else { return nil }
        let encoded = String(url.path.dropFirst())
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: encoded), data.count <= maxLaTeXBytes else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Whether Markdown holds an inline-math image, without parsing it.
    public static func occurs(in markdown: String) -> Bool {
        markdown.contains("](\(scheme):")
    }

    /// Whether Markdown holds an image other than inline math. Literal `![` text also counts, which only costs a
    /// paragraph its synchronous math drawing.
    public static func hasOtherImages(in markdown: String) -> Bool {
        markdown.components(separatedBy: "![").count > markdown.components(separatedBy: "](\(scheme):").count
    }

    /// Plain text with each expression's one-character alt replaced by its LaTeX, which VoiceOver reads (TAL-971).
    /// Nil when the Markdown holds no inline math.
    public static func spokenText(plainText: String, markdown: String) -> String? {
        guard occurs(in: markdown) else { return nil }
        var sources = markdown.components(separatedBy: "](\(scheme):///").dropFirst().map { part in
            latex(from: URL(string: "\(scheme):///" + part.prefix { $0 != ")" })) ?? ""
        }.makeIterator()
        let spoken = plainText.trimmingCharacters(in: .newlines).flatMap { character -> [Character] in
            if character == "\u{FFFC}" { return Array(sources.next() ?? "") }
            return [character.isNewline ? " " : character]
        }
        return String(spoken)
    }
}

private enum InlineDelimiter: CaseIterable {
    case dollar
    case parens

    var openLength: Int {
        switch self {
        case .dollar:
            return 1
        case .parens:
            return 2
        }
    }

    var closeLength: Int {
        switch self {
        case .dollar:
            return 1
        case .parens:
            return 2
        }
    }

    func isOpen(in characters: [Character], at index: Int, protected: [Bool]) -> Bool {
        switch self {
        case .dollar:
            guard MarkdownMathProtection.matches("$", nil, in: characters, at: index, protected: protected) else {
                return false
            }
            if index > 0, characters[index - 1] == "$" { return false }
            if index + 1 < characters.count, characters[index + 1] == "$" { return false }
            // A digit or whitespace after `$` is currency or prose, such as `$250` or `$ 5`.
            if index + 1 < characters.count, characters[index + 1].isNumber || characters[index + 1].isWhitespace {
                return false
            }
            return !MarkdownMathProtection.isEscaped(characters, at: index)
        case .parens:
            return MarkdownMathProtection.matches("\\", "(", in: characters, at: index, protected: protected)
                && !MarkdownMathProtection.isEscaped(characters, at: index)
        }
    }

    func isClose(in characters: [Character], at index: Int, protected: [Bool]) -> Bool {
        switch self {
        case .dollar:
            guard MarkdownMathProtection.matches("$", nil, in: characters, at: index, protected: protected) else {
                return false
            }
            if index > 0, characters[index - 1] == "$" { return false }
            if index + 1 < characters.count, characters[index + 1] == "$" { return false }
            // Whitespace before `$` is a prose boundary, as in KaTeX auto-render.
            if index > 0, characters[index - 1].isWhitespace { return false }
            return !MarkdownMathProtection.isEscaped(characters, at: index)
        case .parens:
            return MarkdownMathProtection.matches("\\", ")", in: characters, at: index, protected: protected)
                && !MarkdownMathProtection.isEscaped(characters, at: index)
        }
    }
}

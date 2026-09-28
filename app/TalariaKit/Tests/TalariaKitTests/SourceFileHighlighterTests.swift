import SwiftUI
import XCTest
@testable import TalariaKit

/// Source viewer lines: exact text with stable one-based numbers, colour only
/// where a grammar exists, and a target line that clamps into the file (TAL-169).
final class SourceFileHighlighterTests: XCTestCase {
    private let highlighter = SourceFileHighlighter()

    func testSwiftFileIsColouredWithExactTextAndStableNumbers() async {
        let content = "import Foundation\n\nlet answer = 42 // ünïcödé ✓\n"
        let lines = await highlighter.lines(in: content, language: "swift", isDark: false)

        XCTAssertEqual(lines.map(\.id), [1, 2, 3, 4])
        XCTAssertEqual(lines.map(\.text), ["import Foundation", " ", "let answer = 42 // ünïcödé ✓", " "])
        XCTAssertTrue(hasColour(lines[0]), "Swift keywords should carry a foreground colour")
        XCTAssertFalse(hasFont(lines[0]), "Engine fonts must not override the viewer's Dynamic Type font")
    }

    func testHighlightrLanguageIsColouredWithExactText() async {
        let content = "def greet(name):\n    return f\"hi {name}\"\n"
        let lines = await highlighter.lines(in: content, language: "python", isDark: true)

        XCTAssertEqual(lines.map(\.text), ["def greet(name):", "    return f\"hi {name}\"", " "])
        XCTAssertTrue(hasColour(lines[0]))
    }

    func testUnknownGrammarStaysPlainWithExactText() async {
        let content = "alpha\r\nbeta\tgamma\n"
        let lines = await highlighter.lines(in: content, language: nil, isDark: false)

        XCTAssertEqual(lines.map(\.id), [1, 2, 3])
        XCTAssertEqual(lines.map(\.text), ["alpha", "beta\tgamma", " "])
        XCTAssertFalse(lines.contains(where: hasColour))
    }

    func testOversizedLineStaysPlainWhileNeighboursAreColoured() async {
        let long = String(repeating: "x", count: MarkdownHighlightPolicy.maxHighlightedCodeLineLength + 1)
        let content = "let a = 1\nlet b = \"\(long)\"\nlet c = 3"
        let lines = await highlighter.lines(in: content, language: "swift", isDark: false)

        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines[1].text, "let b = \"\(long)\"")
        XCTAssertFalse(hasColour(lines[1]), "A line past the policy limit is drawn plain")
        XCTAssertTrue(hasColour(lines[0]))
        XCTAssertTrue(hasColour(lines[2]))
    }

    func testEmojiStraddlingASegmentCutKeepsExactText() async {
        let line = String(repeating: "a", count: MarkdownPlainCodeFormatter.maxSegmentLength - 1) + "😀b"
        let content = "let x = 1\n\(line)\nlet y = 2"
        let lines = await highlighter.lines(in: content, language: "swift", isDark: false)

        XCTAssertEqual(lines.map(\.text), ["let x = 1", line, "let y = 2"])
        XCTAssertFalse(lines[1].text.contains("\u{FFFD}"))
        XCTAssertTrue(hasColour(lines[0]))
    }

    func testFileBeyondThePolicyLimitsStaysPlain() async {
        let content = Array(repeating: "let x = 1", count: MarkdownHighlightPolicy.maxHighlightedCodeLineCount + 1)
            .joined(separator: "\n")
        let lines = await highlighter.lines(in: content, language: "swift", isDark: false)

        XCTAssertEqual(lines.count, MarkdownHighlightPolicy.maxHighlightedCodeLineCount + 1)
        XCTAssertFalse(lines.contains(where: hasColour))
    }

    func testLanguageResolutionPrefersTheServerThenTheExtension() {
        XCTAssertEqual(SourceFileLanguage.resolve(path: "Sources/App.swift", serverLanguage: nil), "swift")
        XCTAssertEqual(SourceFileLanguage.resolve(path: "notes.txt", serverLanguage: "python"), "python")
        XCTAssertEqual(SourceFileLanguage.resolve(path: "lib/util.mjs", serverLanguage: nil), "javascript")
        XCTAssertEqual(SourceFileLanguage.resolve(path: "include/api.h", serverLanguage: "unknownlang"), "c")
        XCTAssertEqual(SourceFileLanguage.resolve(path: "Info.plist", serverLanguage: nil), "xml")
        XCTAssertNil(SourceFileLanguage.resolve(path: "notes.txt", serverLanguage: nil))
        XCTAssertNil(SourceFileLanguage.resolve(path: "Makefile", serverLanguage: ""))
    }

    func testTargetLineClampsIntoTheFile() {
        XCTAssertEqual(SourceFileNavigation.clampedTargetLine(3, lineCount: 10), 3)
        XCTAssertEqual(SourceFileNavigation.clampedTargetLine(99, lineCount: 10), 10)
        XCTAssertEqual(SourceFileNavigation.clampedTargetLine(0, lineCount: 10), 1)
        XCTAssertEqual(SourceFileNavigation.clampedTargetLine(-4, lineCount: 10), 1)
        XCTAssertNil(SourceFileNavigation.clampedTargetLine(nil, lineCount: 10))
        XCTAssertNil(SourceFileNavigation.clampedTargetLine(3, lineCount: 0))
    }

    // The engines emit UIKit attributes on iOS and AppKit attributes on macOS, where these tests run.
    private func hasColour(_ line: SourceLine) -> Bool {
        line.segments.contains { segment in
            #if os(iOS)
            segment.runs.contains { $0.uiKit.foregroundColor != nil }
            #else
            segment.runs.contains { $0.appKit.foregroundColor != nil }
            #endif
        }
    }

    private func hasFont(_ line: SourceLine) -> Bool {
        line.segments.contains { segment in
            #if os(iOS)
            segment.runs.contains { $0.uiKit.font != nil }
            #else
            segment.runs.contains { $0.appKit.font != nil }
            #endif
        }
    }
}

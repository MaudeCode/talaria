import XCTest
@testable import TalariaKit

final class TranscriptMediaParserTests: XCTestCase {
    func testParsesLocalPathToken() {
        let segments = TranscriptMediaParser.segments(
            in: "Screenshot: MEDIA:/Users/hermes/.hermes/browser_screenshots/example.png loaded"
        )

        XCTAssertEqual(segments.count, 3)
        XCTAssertEqual(segments[0], .text("Screenshot: "))
        XCTAssertEqual(
            segments[1],
            .media(.init(rawReference: "/Users/hermes/.hermes/browser_screenshots/example.png"))
        )
        XCTAssertEqual(segments[2], .text(" loaded"))
    }

    func testParsesHTTPSURLToken() throws {
        let segments = TranscriptMediaParser.segments(
            in: "Generated MEDIA:https://cdn.example.test/output/image.png?variant=small"
        )

        let media = try XCTUnwrap(mediaReferences(in: segments).first)
        XCTAssertEqual(media.rawReference, "https://cdn.example.test/output/image.png?variant=small")
        XCTAssertEqual(media.source, .remoteURL(try XCTUnwrap(URL(string: media.rawReference))))
        XCTAssertTrue(media.isRasterImageCandidate)
    }

    func testKeepsSentencePunctuationOutsideToken() {
        let segments = TranscriptMediaParser.segments(
            in: "Open MEDIA:/tmp/result.png, then MEDIA:/tmp/second.webp."
        )

        XCTAssertEqual(
            segments,
            [
                .text("Open "),
                .media(.init(rawReference: "/tmp/result.png")),
                .text(", then "),
                .media(.init(rawReference: "/tmp/second.webp")),
                .text(".")
            ]
        )
    }

    func testStopsAtMarkdownLinkAndParenBoundaries() {
        let segments = TranscriptMediaParser.segments(
            in: "[view](MEDIA:/tmp/result.png) and [MEDIA:/tmp/other.jpg]"
        )

        XCTAssertEqual(
            segments,
            [
                .text("[view]("),
                .media(.init(rawReference: "/tmp/result.png")),
                .text(") and ["),
                .media(.init(rawReference: "/tmp/other.jpg")),
                .text("]")
            ]
        )
    }

    func testKeepsClosingMarkdownEmphasisOutsideToken() {
        let segments = TranscriptMediaParser.segments(
            in: "**MEDIA:/tmp/agyloop-plan.md** and _MEDIA:/tmp/trade_journal.csv_"
        )

        XCTAssertEqual(
            segments,
            [
                .text("**"),
                .media(.init(rawReference: "/tmp/agyloop-plan.md")),
                .text("** and _"),
                .media(.init(rawReference: "/tmp/trade_journal.csv")),
                .text("_")
            ]
        )
    }

    func testParsesMultipleTokens() {
        let segments = TranscriptMediaParser.segments(
            in: "A MEDIA:/tmp/a.png\nB MEDIA:/tmp/b.jpg"
        )

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/tmp/a.png", "/tmp/b.jpg"]
        )
    }

    func testFencedCodeKeepsLiteralMediaText() {
        let markdown = """
        Before
        ```swift
        let path = "MEDIA:/tmp/inside.png"
        ```
        After MEDIA:/tmp/outside.png
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(mediaReferences(in: segments).map(\.rawReference), ["/tmp/outside.png"])
        XCTAssertTrue(textSegments(in: segments).joined().contains("MEDIA:/tmp/inside.png"))
    }

    func testParsesBareFileURLsAtLineStartOrAfterWhitespace() {
        let segments = TranscriptMediaParser.segments(
            in: "file:///tmp/report.csv ready\nImage file:///tmp/chart.png."
        )

        XCTAssertEqual(
            segments,
            [
                .media(.init(rawReference: "/tmp/report.csv")),
                .text(" ready\nImage "),
                .media(.init(rawReference: "/tmp/chart.png")),
                .text(".")
            ]
        )
    }

    func testBareFileURLDecodesPercentEscapedPathComponents() {
        let segments = TranscriptMediaParser.segments(
            in: "Created file:///Users/hermes/workspace/Q3%20report%20%28final%29.csv"
        )

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/Users/hermes/workspace/Q3 report (final).csv"]
        )
    }

    func testBareFileURLKeepsSurroundingProseAndPunctuation() {
        let segments = TranscriptMediaParser.segments(
            in: "Created file:///tmp/report.csv, then shared file:///tmp/chart.webp!"
        )

        XCTAssertEqual(
            segments,
            [
                .text("Created "),
                .media(.init(rawReference: "/tmp/report.csv")),
                .text(", then shared "),
                .media(.init(rawReference: "/tmp/chart.webp")),
                .text("!")
            ]
        )
    }

    func testBareFileURLRequiresWhitespaceOrLineStart() {
        let markdown = "prefixfile:///tmp/hidden.txt and [report](file:///tmp/report.csv)"
        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(segments, [.text(markdown)])
    }

    func testBareFileURLInsideInlineOrFencedCodeStaysLiteral() {
        let markdown = """
        Before `open file:///tmp/inline.csv` after file:///tmp/outside.csv
        ```text
        file:///tmp/fenced.png
        ```
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(mediaReferences(in: segments).map(\.rawReference), ["/tmp/outside.csv"])
        let text = textSegments(in: segments).joined()
        XCTAssertTrue(text.contains("file:///tmp/inline.csv"))
        XCTAssertTrue(text.contains("file:///tmp/fenced.png"))
    }

    func testBareFileURLUsesExistingMediaKindClassification() {
        let segments = TranscriptMediaParser.segments(
            in: "file:///tmp/image.png file:///tmp/audio.m4a file:///tmp/video.mp4 file:///tmp/data.zip"
        )

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.mediaKind),
            [.image, .audio, .video, .unsupported]
        )
    }

    func testBareFileURLSupportDoesNotChangeExistingMediaOrHTTPSBehavior() throws {
        let segments = TranscriptMediaParser.segments(
            in: "MEDIA:/tmp/local.png MEDIA:https://cdn.example.test/image.png"
        )
        let references = mediaReferences(in: segments)

        XCTAssertEqual(references.map(\.rawReference), [
            "/tmp/local.png",
            "https://cdn.example.test/image.png"
        ])
        XCTAssertEqual(references[0].source, .localPath("/tmp/local.png"))
        XCTAssertEqual(
            references[1].source,
            .remoteURL(try XCTUnwrap(URL(string: "https://cdn.example.test/image.png")))
        )
    }

    // MARK: - Markdown images (TAL-168)

    func testMarkdownImageWithAbsolutePathBecomesMediaWithAltText() {
        let segments = TranscriptMediaParser.segments(
            in: "Login ![Login screen](/tmp/shots/login.png \"Title\") captured."
        )

        XCTAssertEqual(
            segments,
            [
                .text("Login "),
                .media(.init(rawReference: "/tmp/shots/login.png", altText: "Login screen")),
                .text(" captured.")
            ]
        )
        XCTAssertEqual(mediaReferences(in: segments).first?.accessibilityName, "Login screen")
        XCTAssertEqual(mediaReferences(in: segments).first?.source, .localPath("/tmp/shots/login.png"))
    }

    func testMarkdownImageWithoutAltTextFallsBackToFileNameForAccessibility() throws {
        let segments = TranscriptMediaParser.segments(in: "![](</tmp/shots/final shot.png>)")
        let media = try XCTUnwrap(mediaReferences(in: segments).first)

        XCTAssertNil(media.altText)
        XCTAssertEqual(media.rawReference, "/tmp/shots/final shot.png")
        XCTAssertEqual(media.accessibilityName, "final shot.png")
    }

    func testMarkdownImageFileURLDecodesToLocalPath() {
        let segments = TranscriptMediaParser.segments(
            in: "![chart](file:///tmp/reports/Q3%20chart.png)"
        )

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/tmp/reports/Q3 chart.png"]
        )
    }

    func testMarkdownImageWorkspaceRelativeDestinationsJoinTheWorkspaceRoot() throws {
        let workspace = "/srv/workspaces/app"
        let expectations = [
            "./shots/login.png": "/srv/workspaces/app/shots/login.png",
            "../other/shots/login.png": "/srv/workspaces/other/shots/login.png",
            "./../other/../app/shots/login.png": "/srv/workspaces/app/shots/login.png"
        ]

        for (destination, expected) in expectations {
            let segments = TranscriptMediaParser.segments(
                in: "![shot](\(destination))",
                workspaceRoot: workspace
            )
            let media = try XCTUnwrap(mediaReferences(in: segments).first, destination)
            XCTAssertEqual(media.rawReference, expected, destination)
        }
    }

    func testMarkdownImageWorkspaceRelativeDestinationsRequireWorkspaceRoot() {
        for destination in ["./shots/login.png", "../shots/login.png"] {
            let markdown = "![shot](\(destination))"
            XCTAssertEqual(TranscriptMediaParser.segments(in: markdown), [.text(markdown)], destination)
            XCTAssertEqual(
                TranscriptMediaParser.segments(in: markdown, workspaceRoot: "relative/root"),
                [.text(markdown)],
                destination
            )
        }
    }

    func testMarkdownImageHomeRelativeDestinationIsSentToServerUnexpanded() {
        let segments = TranscriptMediaParser.segments(
            in: "![shot](~/shots/login.png)",
            workspaceRoot: "/srv/workspaces/app"
        )

        XCTAssertEqual(mediaReferences(in: segments).map(\.rawReference), ["~/shots/login.png"])
    }

    func testMarkdownImageRemoteAndBareRelativeDestinationsStayText() {
        for markdown in [
            "![remote](https://cdn.example.test/image.png)",
            "![remote](http://cdn.example.test/image.png)",
            "![data](data:image/png;base64,AAAA)",
            "![bare](shots/login.png)",
            "![bare](login.png)"
        ] {
            XCTAssertEqual(
                TranscriptMediaParser.segments(in: markdown, workspaceRoot: "/srv/workspaces/app"),
                [.text(markdown)],
                markdown
            )
        }
    }

    func testMarkdownImageNonRasterDestinationStaysText() {
        let markdown = "![report](/tmp/report.csv) ![vector](/tmp/vector.svg)"

        XCTAssertEqual(TranscriptMediaParser.segments(in: markdown), [.text(markdown)])
    }

    func testMarkdownImageInsideCodeStaysLiteral() {
        let markdown = """
        Use `![x](/tmp/inline.png)` then ![y](/tmp/outside.png)
        ```markdown
        ![z](/tmp/fenced.png)
        ```
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(mediaReferences(in: segments).map(\.rawReference), ["/tmp/outside.png"])
        let text = textSegments(in: segments).joined()
        XCTAssertTrue(text.contains("![x](/tmp/inline.png)"))
        XCTAssertTrue(text.contains("![z](/tmp/fenced.png)"))
    }

    func testMarkdownImagePercentEncodedDestinationDecodesOnce() throws {
        let segments = TranscriptMediaParser.segments(
            in: "![shot](/tmp/final%20shot%20%28v2%29.png) ![rel](./shots/a%20b.png)",
            workspaceRoot: "/srv/workspaces/app"
        )

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/tmp/final shot (v2).png", "/srv/workspaces/app/shots/a b.png"]
        )
    }

    func testMarkdownImageInsideHTMLCommentStaysHidden() {
        let markdown = """
        Visible ![y](/tmp/outside.png) <!-- ![x](/tmp/inline-comment.png) --> tail
        <!--
        ![z](/tmp/block-comment.png) file:///tmp/commented.png
        -->
        After ![w](/tmp/after.png)
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/tmp/outside.png", "/tmp/after.png"]
        )
        let text = textSegments(in: segments).joined()
        XCTAssertTrue(text.contains("<!-- ![x](/tmp/inline-comment.png) -->"))
        XCTAssertTrue(text.contains("![z](/tmp/block-comment.png) file:///tmp/commented.png"))
    }

    func testMarkdownImageAfterMultilineCommentCloseIsExtracted() {
        let markdown = """
        <!--
        ![hidden](/tmp/hidden.png)
        hidden --> ![visible](/tmp/visible.png) tail
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(mediaReferences(in: segments).map(\.rawReference), ["/tmp/visible.png"])
        XCTAssertEqual(segments.last, .text(" tail"))
    }

    func testMarkdownImageCommentMarkerInsideInlineCodeDoesNotHideLaterImages() {
        let markdown = """
        Type `<!--` to start a comment ![same](/tmp/same-line.png)
        ![next](/tmp/next-line.png)
        """

        let segments = TranscriptMediaParser.segments(in: markdown)

        XCTAssertEqual(
            mediaReferences(in: segments).map(\.rawReference),
            ["/tmp/same-line.png", "/tmp/next-line.png"]
        )
    }

    func testMarkdownImageAcceptsOptionalTitleButRejectsOtherTrailingContent() {
        for markdown in [
            "![x](/tmp/a.png \"Title\")",
            "![x](/tmp/a.png 'Title')",
            "![x](/tmp/a.png (Title))",
            "![x](</tmp/a.png> \"Title\")"
        ] {
            XCTAssertEqual(
                TranscriptMediaParser.segments(in: markdown),
                [.media(.init(rawReference: "/tmp/a.png", altText: "x"))],
                markdown
            )
        }

        for markdown in [
            "![x](/tmp/a.png garbage)",
            "![x](/tmp/a.png \"unterminated)",
            "![x](/tmp/a.png\"Title\")",
            "![x](</tmp/a.png>garbage)"
        ] {
            XCTAssertEqual(TranscriptMediaParser.segments(in: markdown), [.text(markdown)], markdown)
        }
    }

    func testMarkdownImageEscapedOrMalformedSyntaxStaysText() {
        for markdown in [
            "\\![escaped](/tmp/escaped.png)",
            "![unterminated](/tmp/open.png",
            "![no destination]()",
            "![missing paren] (/tmp/spaced.png)",
            "![alt\\](/tmp/broken.png)",
            "![alt](/tmp/one.png\\)"
        ] {
            XCTAssertEqual(TranscriptMediaParser.segments(in: markdown), [.text(markdown)], markdown)
        }
    }

    func testMarkdownImageHandlesNestedAndEscapedDelimiters() {
        let segments = TranscriptMediaParser.segments(
            in: "![Build [1] (final)](/tmp/build(1)/shot.png) and ![x](/tmp/a\\)b.png)"
        )

        XCTAssertEqual(
            segments,
            [
                .media(.init(rawReference: "/tmp/build(1)/shot.png", altText: "Build [1] (final)")),
                .text(" and "),
                .media(.init(rawReference: "/tmp/a)b.png", altText: "x"))
            ]
        )
    }

    func testMarkdownImageDoesNotChangeMediaTokenOrBareFileURLBehavior() {
        let segments = TranscriptMediaParser.segments(
            in: "![tok](MEDIA:/tmp/token.png) MEDIA:/tmp/plain.png file:///tmp/bare.png"
        )

        XCTAssertEqual(
            segments,
            [
                .text("![tok]("),
                .media(.init(rawReference: "/tmp/token.png")),
                .text(") "),
                .media(.init(rawReference: "/tmp/plain.png")),
                .text(" "),
                .media(.init(rawReference: "/tmp/bare.png"))
            ]
        )
    }

    func testUnsupportedSVGIsNotRasterImageCandidate() {
        let segments = TranscriptMediaParser.segments(in: "MEDIA:/tmp/vector.svg")
        let media = mediaReferences(in: segments).first

        XCTAssertEqual(media?.rawReference, "/tmp/vector.svg")
        XCTAssertEqual(media?.isRasterImageCandidate, false)
    }

    func testDetectsAudioAndVideoMediaKinds() {
        let references = [
            TranscriptMediaReference(rawReference: "/tmp/output.mp3"),
            TranscriptMediaReference(rawReference: "/tmp/output.m4a"),
            TranscriptMediaReference(rawReference: "/tmp/output.wav"),
            TranscriptMediaReference(rawReference: "/tmp/output.aac"),
            TranscriptMediaReference(rawReference: "/tmp/output.caf"),
            TranscriptMediaReference(rawReference: "https://cdn.example.test/output.mp4?download=1"),
            TranscriptMediaReference(rawReference: "/tmp/output.mov"),
            TranscriptMediaReference(rawReference: "/tmp/output.m4v")
        ]

        XCTAssertEqual(references[0].mediaKind, .audio)
        XCTAssertEqual(references[1].mediaKind, .audio)
        XCTAssertEqual(references[2].mediaKind, .audio)
        XCTAssertEqual(references[3].mediaKind, .audio)
        XCTAssertEqual(references[4].mediaKind, .audio)
        XCTAssertEqual(references[5].mediaKind, .video)
        XCTAssertEqual(references[6].mediaKind, .video)
        XCTAssertEqual(references[7].mediaKind, .video)
    }

    func testUnsupportedTextAndDataFilesAreClassifiedAsUnsupported() {
        let references = [
            TranscriptMediaReference(rawReference: "/tmp/report.txt"),
            TranscriptMediaReference(rawReference: "/tmp/data.csv"),
            TranscriptMediaReference(rawReference: "/tmp/notes.md"),
            TranscriptMediaReference(rawReference: "/tmp/config.json"),
            TranscriptMediaReference(rawReference: "/tmp/archive.zip"),
        ]

        for reference in references {
            XCTAssertEqual(reference.mediaKind, .unsupported, "\(reference.rawReference) must be .unsupported")
        }
    }

    func testUnsupportedFileExportPayloadKeepsOriginalNameAndExtension() {
        let reference = TranscriptMediaReference(rawReference: "/tmp/report.txt")
        let data = "hello".data(using: .utf8)!

        let payload = TranscriptMediaExportSupport.payload(
            for: reference,
            data: data,
            resolvedKind: .data
        )

        XCTAssertEqual(payload.filename, "report.txt")
        XCTAssertEqual(payload.data, data)
        XCTAssertFalse(payload.isImage)
        XCTAssertFalse(payload.isVideo)
    }

    func testParsedGenericFileURLExportKeepsDecodedOriginalNameAndExtension() throws {
        let segments = TranscriptMediaParser.segments(
            in: "file:///tmp/final%20report.csv"
        )
        let reference = try XCTUnwrap(mediaReferences(in: segments).first)
        let data = Data("heading,value".utf8)

        let payload = TranscriptMediaExportSupport.payload(
            for: reference,
            data: data,
            resolvedKind: .data
        )

        XCTAssertEqual(reference.rawReference, "/tmp/final report.csv")
        XCTAssertEqual(payload.filename, "final report.csv")
        XCTAssertEqual(payload.data, data)
    }

    func testExtensionlessUnsupportedFileExportsAsDataNotVideo() {
        let reference = TranscriptMediaReference(rawReference: "/tmp/results")
        let data = "binary".data(using: .utf8)!

        let payload = TranscriptMediaExportSupport.payload(
            for: reference,
            data: data,
            resolvedKind: .data
        )

        XCTAssertEqual(payload.filename, "results.bin")
        XCTAssertEqual(payload.contentType, .data)
        XCTAssertFalse(payload.isImage)
        XCTAssertFalse(payload.isVideo)
    }

    func testExtensionlessRemoteReferenceRemainsImageCandidateButCanFallbackToMedia() throws {
        let remoteURL = try XCTUnwrap(URL(string: "https://cdn.example.test/media/abc123"))
        let reference = TranscriptMediaReference(rawReference: remoteURL.absoluteString)

        XCTAssertEqual(reference.source, .remoteURL(remoteURL))
        XCTAssertEqual(reference.mediaKind, .image)
        XCTAssertTrue(reference.isRasterImageCandidate)
        XCTAssertTrue(reference.isExtensionlessRemoteMediaCandidate)
    }

    func testEmptyReferenceDisplayNameFallsBackToMedia() {
        XCTAssertEqual(TranscriptMediaReference(rawReference: "").displayName, "Media")
    }

    func testImageCacheSeparatesSameResourceAcrossSessions() async {
        let firstSessionKey = DecodedImageCacheKey(
            namespace: "https://one.example.test|session-a",
            resourceID: "/tmp/result.png"
        )
        let secondSessionKey = DecodedImageCacheKey(
            namespace: "https://one.example.test|session-b",
            resourceID: "/tmp/result.png"
        )
        let secondServerKey = DecodedImageCacheKey(
            namespace: "https://two.example.test|session-a",
            resourceID: "/tmp/result.png"
        )

        XCTAssertNotEqual(firstSessionKey, secondSessionKey)
        XCTAssertNotEqual(firstSessionKey, secondServerKey)

        let cache = DecodedImageCache()
        let firstImage = PlatformImage()
        let secondImage = PlatformImage()
        let loadedFirst = await cache.image(for: firstSessionKey) { firstImage }
        let loadedSecond = await cache.image(for: secondSessionKey) { secondImage }
        let cachedFirst = await cache.image(for: firstSessionKey) { nil }

        XCTAssertTrue(loadedFirst === firstImage)
        XCTAssertTrue(loadedSecond === secondImage)
        XCTAssertTrue(cachedFirst === firstImage)
    }

    private func mediaReferences(in segments: [TranscriptMediaSegment]) -> [TranscriptMediaReference] {
        segments.compactMap { segment in
            if case let .media(reference) = segment {
                return reference
            }
            return nil
        }
    }

    private func textSegments(in segments: [TranscriptMediaSegment]) -> [String] {
        segments.compactMap { segment in
            if case let .text(text) = segment {
                return text
            }
            return nil
        }
    }
}

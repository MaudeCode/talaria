import Foundation

/// TAL-1968: the transcript's reference from a `show` result (`ShowBlockRefSchema`); the block loads from
/// `GET /api/show/{block_id}`.
public struct ShowBlockRef: Decodable, Equatable, Sendable {
    public let blockId: String
    public let kind: String
    public let title: String

    public init(blockId: String, kind: String, title: String) {
        self.blockId = blockId
        self.kind = kind
        self.title = title
    }
}

/// TAL-1968: a file, table, chart or HTML page an agent showed (`ShowBlockSchema`). The server validates, caps and
/// formats every field; the App renders them. Decodes with `DecisionReview.decoder`; a kind this App does not know
/// fails to decode, so its section shows the title alone.
public struct ShowBlock: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Equatable, Sendable {
        case file, table, chart, html
    }

    public struct File: Decodable, Equatable, Sendable {
        public let path: String
        public let name: String
        public let size: Int
    }

    /// A `DisplayMediaSchema` row: `url` is relative to the server root.
    public struct Media: Decodable, Equatable, Sendable {
        public let url: String
        public let name: String
        public let mime: String
        public let kind: String
    }

    /// The agent's row and column counts when the server cut the table to its caps.
    public struct Truncation: Decodable, Equatable, Sendable {
        public let totalRows: Int
        public let totalColumns: Int
    }

    public struct Point: Decodable, Equatable, Sendable {
        public let label: String
        public let value: Double
        /// The value as the server formatted it, unit included.
        public let display: String
    }

    /// The point the server chose as the series' peak, for its accessibility summary.
    public struct Peak: Decodable, Equatable, Sendable {
        public let label: String
        public let display: String
    }

    public struct Series: Decodable, Equatable, Sendable {
        public let name: String
        public let points: [Point]
        public let maxDisplay: String
        public let peak: Peak?
    }

    public let blockId: String
    public let sessionId: String
    public let title: String
    public let kind: Kind
    // `file`
    public let file: File?
    public let media: Media?
    /// A text file's workspace path, the file its Open action shows.
    public let focusPath: String?
    // `table`
    public let columns: [String]
    public let rows: [[String]]
    public let truncation: Truncation?
    /// The shown table as tab-separated text, header first, for Copy.
    public let tsv: String
    // `chart`
    public let chart: String?
    public let series: [Series]
    // `html`
    /// The sandboxed page's grant URL, relative to the server root, minted for this read.
    public let frameUrl: String?

    enum CodingKeys: String, CodingKey {
        case blockId, sessionId, title, kind, file, media, focusPath, columns, rows, truncation, tsv, chart, series, frameUrl
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        blockId = try container.decode(String.self, forKey: .blockId)
        kind = try container.decode(Kind.self, forKey: .kind)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId) ?? ""
        title = container.decodeLossyStringIfPresent(forKey: .title) ?? ""
        file = try? container.decodeIfPresent(File.self, forKey: .file)
        media = try? container.decodeIfPresent(Media.self, forKey: .media)
        focusPath = container.decodeLossyStringIfPresent(forKey: .focusPath)
        columns = container.decodeLossyArrayIfPresent(String.self, forKey: .columns) ?? []
        rows = (try? container.decodeIfPresent([[String]].self, forKey: .rows)) ?? []
        truncation = try? container.decodeIfPresent(Truncation.self, forKey: .truncation)
        tsv = container.decodeLossyStringIfPresent(forKey: .tsv) ?? ""
        chart = container.decodeLossyStringIfPresent(forKey: .chart)
        series = container.decodeLossyArrayIfPresent(Series.self, forKey: .series) ?? []
        frameUrl = container.decodeLossyStringIfPresent(forKey: .frameUrl)
    }
}

import Foundation
import Network
import os

/// A disposable HTTP/1.1 server on an OS-assigned 127.0.0.1 port, so tests can
/// drive real `URLSession` redirect handling. Two instances are distinct origins
/// (same scheme and host, different ports). Each connection serves one request
/// and closes.
final class LoopbackHTTPServer: @unchecked Sendable {
    struct Request: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data

        func header(_ name: String) -> String? {
            headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
    }

    struct Response: Sendable {
        var status: Int
        var headers: [String: String] = [:]
        var body = Data()

        static func json(_ text: String) -> Response {
            Response(status: 200, headers: ["Content-Type": "application/json"], body: Data(text.utf8))
        }

        static func redirect(_ status: Int, to url: URL) -> Response {
            Response(status: status, headers: ["Location": url.absoluteString])
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "LoopbackHTTPServer")
    private let recorded = OSAllocatedUnfairLock(initialState: [Request]())
    private let handler: @Sendable (Request) -> Response
    private(set) var port: UInt16 = 0

    init(handler: @escaping @Sendable (Request) -> Response) throws {
        self.handler = handler
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)

        let ready = DispatchSemaphore(value: 0)
        let failure = OSAllocatedUnfairLock<NWError?>(initialState: nil)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): failure.withLock { $0 = error }; ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
        if let error = failure.withLock({ $0 }) { throw error }
        guard let port = listener.port?.rawValue else { throw URLError(.cannotFindHost) }
        self.port = port
    }

    deinit { listener.cancel() }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func url(_ path: String) -> URL { baseURL.appendingPathComponent(path) }

    var requests: [Request] { recorded.withLock { $0 } }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, isComplete, error in
            guard let self else { return connection.cancel() }
            var buffer = buffer
            if let chunk { buffer.append(chunk) }
            if let request = Self.parse(buffer) {
                recorded.withLock { $0.append(request) }
                connection.send(content: Self.encode(handler(request)), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            } else if isComplete || error != nil {
                connection.cancel()
            } else {
                receive(on: connection, buffer: buffer)
            }
        }
    }

    /// Returns the request once its headers and `Content-Length` body have arrived.
    private static func parse(_ buffer: Data) -> Request? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buffer[..<headerEnd.lowerBound], encoding: .utf8)
        else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[String(line[..<colon])] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = headers.first { $0.key.lowercased() == "content-length" }.flatMap { Int($0.value) } ?? 0
        let body = buffer[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return Request(
            method: String(requestLine[0]),
            path: String(requestLine[1]),
            headers: headers,
            body: Data(body.prefix(length))
        )
    }

    private static func encode(_ response: Response) -> Data {
        var head = "HTTP/1.1 \(response.status) \(HTTPURLResponse.localizedString(forStatusCode: response.status))\r\n"
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        return Data(head.utf8) + response.body
    }
}

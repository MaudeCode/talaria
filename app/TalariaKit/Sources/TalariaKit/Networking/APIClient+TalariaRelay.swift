import Foundation

private struct TalariaRelayPairRequest: Encodable {
    var relayURL: String
    var publisherID: String
    var publisherInvitation: String
    var label: String
}

private struct TalariaRelayPairResponse: Decodable {
    var ok: Bool
}

extension APIClient {
    /// Asks the Web server to pair this publisher with Talaria Relay; returns whether the server accepted.
    public func requestTalariaRelayPairing(invitation: String, relayURL: URL, publisherID: URL) async throws -> Bool {
        let response: TalariaRelayPairResponse = try await send(
            endpoint: .talariaRelayPair,
            method: "POST",
            body: TalariaRelayPairRequest(
                relayURL: relayURL.absoluteString,
                publisherID: publisherID.absoluteString,
                publisherInvitation: invitation,
                label: publisherID.host() ?? "Hermes WebUI"
            )
        )
        return response.ok
    }
}
